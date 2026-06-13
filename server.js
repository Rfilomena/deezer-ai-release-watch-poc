const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");

loadEnvFile();

const PORT = Number(process.env.PORT || 5057);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = path.join(__dirname, "public");
const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_API = "https://api.spotify.com/v1";
const DEEZER_API = "https://api.deezer.com";

let spotifyToken = null;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/api/health") {
      return sendJson(res, 200, {
        ok: true,
        spotifyConfigured: Boolean(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET),
      });
    }

    if (req.method === "POST" && url.pathname === "/api/scan") {
      const body = await readJson(req);
      const result = await scan(body);
      return sendJson(res, 200, result);
    }

    if (req.method === "GET") {
      return serveStatic(url.pathname, res);
    }

    sendJson(res, 405, { error: "Method not allowed" });
  } catch (error) {
    sendJson(res, 500, {
      error: error.message || "Unexpected error",
      details: error.cause?.message,
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Deezer AI Release Watch POC running at http://localhost:${PORT}`);
});

function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

async function scan(body) {
  const mode = body.mode || "manual";
  const market = (body.market || "US").trim().toUpperCase();
  const maxAlbums = clamp(Number(body.maxAlbums || 10), 1, 50);
  const rows = parseInputRows(body.input || "");

  if (!rows.length) {
    return { rows: [], summary: { scanned: 0, aiFound: 0, matched: 0 } };
  }

  let releases = [];

  if (mode === "manual") {
    releases = rows.map(parseManualRelease).filter(Boolean);
  } else if (mode === "spotify-albums") {
    releases = await spotifyAlbumsFromRows(rows, market);
  } else if (mode === "spotify-artists") {
    releases = await spotifyArtistReleasesFromRows(rows, market, maxAlbums);
  } else {
    throw new Error(`Unknown scan mode: ${mode}`);
  }

  const limited = releases.slice(0, mode === "spotify-artists" ? maxAlbums * rows.length : 100);
  const results = [];

  for (const release of limited) {
    results.push(await enrichWithDeezer(release));
  }

  return {
    rows: results,
    summary: {
      scanned: results.length,
      matched: results.filter((row) => row.deezer?.matched).length,
      aiFound: results.filter((row) => row.ai.status === "found").length,
      noMatch: results.filter((row) => !row.deezer?.matched).length,
    },
  };
}

function parseInputRows(input) {
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function parseManualRelease(line) {
  const parts = line.split(/[|\t,]/).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return null;

  return {
    source: "manual",
    artistName: parts[0],
    albumName: parts[1],
    upc: parts[2] || "",
    releaseDate: "",
    spotifyAlbumId: "",
    spotifyUrl: "",
    spotifyLabel: "",
    tracks: [],
  };
}

async function spotifyAlbumsFromRows(rows, market) {
  const releases = [];
  for (const row of rows) {
    const albumId = extractSpotifyId(row, "album");
    if (!albumId) {
      releases.push(errorRelease(row, "Could not parse Spotify album ID"));
      continue;
    }
    releases.push(await getSpotifyAlbumRelease(albumId, market));
  }
  return releases;
}

async function spotifyArtistReleasesFromRows(rows, market, maxAlbums) {
  const releases = [];
  for (const row of rows) {
    const artistId = extractSpotifyId(row, "artist");
    if (!artistId) {
      releases.push(errorRelease(row, "Could not parse Spotify artist ID"));
      continue;
    }

    const albums = await spotifyGet(`/artists/${artistId}/albums?include_groups=album,single&market=${encodeURIComponent(market)}&limit=10`);
    const sorted = dedupeAlbums(albums.items || [])
      .sort((a, b) => normalizedDate(b.release_date).localeCompare(normalizedDate(a.release_date)))
      .slice(0, maxAlbums);

    for (const album of sorted) {
      releases.push(await getSpotifyAlbumRelease(album.id, market));
    }
  }
  return releases;
}

async function getSpotifyAlbumRelease(albumId, market) {
  const album = await spotifyGet(`/albums/${albumId}?market=${encodeURIComponent(market)}`);
  const simplifiedTracks = album.tracks?.items || [];
  const trackIds = simplifiedTracks.map((track) => track.id).filter(Boolean);
  const detailedTracks = await getSpotifyTracks(trackIds, market);

  return {
    source: "spotify",
    artistName: (album.artists || []).map((artist) => artist.name).join(", "),
    albumName: album.name || "",
    upc: album.external_ids?.upc || album.external_ids?.ean || "",
    releaseDate: album.release_date || "",
    spotifyAlbumId: album.id,
    spotifyUrl: album.external_urls?.spotify || "",
    spotifyLabel: album.label || "",
    albumType: album.album_type || "",
    tracks: detailedTracks.map((track) => ({
      id: track.id,
      name: track.name,
      artistName: (track.artists || []).map((artist) => artist.name).join(", "),
      isrc: track.external_ids?.isrc || "",
      spotifyUrl: track.external_urls?.spotify || "",
    })),
  };
}

async function getSpotifyTracks(ids, market) {
  const chunks = [];
  for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));
  const tracks = [];

  for (const chunk of chunks) {
    if (!chunk.length) continue;
    const data = await spotifyGet(`/tracks?ids=${encodeURIComponent(chunk.join(","))}&market=${encodeURIComponent(market)}`);
    tracks.push(...(data.tracks || []).filter(Boolean));
  }

  return tracks;
}

async function spotifyGet(endpoint) {
  const token = await getSpotifyToken();
  const response = await fetchWithTimeout(`${SPOTIFY_API}${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Spotify API ${response.status}: ${text.slice(0, 240)}`);
  }

  return response.json();
}

async function getSpotifyToken() {
  if (spotifyToken && spotifyToken.expiresAt > Date.now() + 60_000) {
    return spotifyToken.accessToken;
  }

  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Spotify credentials are not configured. Add SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET to .env.");
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const response = await fetchWithTimeout(SPOTIFY_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Spotify token request failed ${response.status}: ${text.slice(0, 240)}`);
  }

  const data = await response.json();
  spotifyToken = {
    accessToken: data.access_token,
    expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
  };
  return spotifyToken.accessToken;
}

async function enrichWithDeezer(release) {
  if (release.error) {
    return {
      release,
      deezer: { matched: false, method: "", error: release.error },
      ai: { status: "unknown", label: "Input error", evidence: [] },
    };
  }

  const match = await findDeezerAlbum(release);

  if (!match.album) {
    return {
      release,
      deezer: { matched: false, method: match.method || "", error: match.error || "" },
      ai: { status: "unknown", label: "No Deezer match", evidence: [] },
    };
  }

  const inspected = await buildDeezerInspectionPayload(match.album);
  const evidence = findAiEvidence(inspected);
  const status = evidence.length ? "found" : "not_exposed";

  return {
    release,
    deezer: {
      matched: true,
      method: match.method,
      albumId: match.album.id,
      albumTitle: match.album.title,
      artistName: match.album.artist?.name || (match.album.contributors || []).map((artist) => artist.name).filter(Boolean).join(", "),
      label: match.album.label || "",
      link: match.album.link || "",
      releaseDate: match.album.release_date || "",
      trackCount: match.album.nb_tracks || match.album.tracks?.data?.length || "",
    },
    ai: {
      status,
      label: status === "found" ? "AI indicator found" : "No AI indicator exposed",
      evidence,
    },
  };
}

async function findDeezerAlbum(release) {
  const attempts = [];

  if (release.upc) {
    attempts.push({
      method: "upc",
      url: `${DEEZER_API}/album/upc:${encodeURIComponent(release.upc)}`,
    });
  }

  for (const track of (release.tracks || []).filter((track) => track.isrc).slice(0, 5)) {
    attempts.push({
      method: `track-isrc:${track.isrc}`,
      url: `${DEEZER_API}/track/isrc:${encodeURIComponent(track.isrc)}`,
      fromTrack: true,
    });
  }

  const strictQuery = `artist:"${release.artistName}" album:"${release.albumName}"`;
  attempts.push({
    method: "album-search-strict",
    url: `${DEEZER_API}/search/album?q=${encodeURIComponent(strictQuery)}&limit=3`,
    search: true,
  });
  attempts.push({
    method: "album-search-loose",
    url: `${DEEZER_API}/search/album?q=${encodeURIComponent(`${release.artistName} ${release.albumName}`)}&limit=3`,
    search: true,
  });

  const errors = [];

  for (const attempt of attempts) {
    try {
      const data = await deezerGet(attempt.url);

      if (data?.error) {
        errors.push(`${attempt.method}: ${data.error.message || data.error.type || "Deezer error"}`);
        continue;
      }

      if (attempt.fromTrack && data.album?.id) {
        const album = await deezerGet(`${DEEZER_API}/album/${data.album.id}`);
        if (!album?.error) return { album, method: attempt.method };
      } else if (attempt.search) {
        const best = pickBestAlbumSearchResult(data.data || [], release);
        if (best?.id) {
          const album = await deezerGet(`${DEEZER_API}/album/${best.id}`);
          if (!album?.error) return { album, method: attempt.method };
        }
      } else if (data?.id) {
        return { album: data, method: attempt.method };
      }
    } catch (error) {
      errors.push(`${attempt.method}: ${error.message}`);
    }
  }

  return { album: null, method: "", error: errors.join(" | ") };
}

async function buildDeezerInspectionPayload(album) {
  const payload = { album };
  const tracks = album.tracks?.data || [];
  payload.tracks = [];

  for (const track of tracks.slice(0, 25)) {
    if (!track.id) continue;
    try {
      const fullTrack = await deezerGet(`${DEEZER_API}/track/${track.id}`);
      payload.tracks.push(fullTrack?.error ? track : fullTrack);
    } catch {
      payload.tracks.push(track);
    }
  }

  const artistId = album.artist?.id || album.contributors?.[0]?.id;
  if (artistId) {
    try {
      const artist = await deezerGet(`${DEEZER_API}/artist/${artistId}`);
      if (!artist?.error) payload.artist = artist;
    } catch {
      // Artist details are optional for this proof.
    }
  }

  return payload;
}

async function deezerGet(url) {
  const response = await fetchWithTimeout(url);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Deezer API ${response.status}: ${text.slice(0, 240)}`);
  }
  return response.json();
}

function findAiEvidence(value) {
  const evidence = [];
  walk(value, [], evidence);
  return evidence.slice(0, 20);
}

function walk(value, pathParts, evidence) {
  if (evidence.length >= 50 || value === null || value === undefined) return;

  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, pathParts.concat(String(index)), evidence));
    return;
  }

  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      inspectField(key, child, pathParts.concat(key), evidence);
      walk(child, pathParts.concat(key), evidence);
    }
    return;
  }

  inspectField(pathParts[pathParts.length - 1] || "value", value, pathParts, evidence);
}

function inspectField(key, value, pathParts, evidence) {
  const pathText = pathParts.join(".");
  const keyLooksAi = /(^|[_-])(ai|aigc)([_-]|$)|generated.*ai|ai.*generated|synthetic|artificial/i.test(key);

  if (typeof value === "boolean" && value === true && keyLooksAi) {
    evidence.push({ path: pathText, value: "true" });
    return;
  }

  if (typeof value === "number" && keyLooksAi && value > 0) {
    evidence.push({ path: pathText, value: String(value) });
    return;
  }

  if (typeof value === "string") {
    const text = value.trim();
    const valueLooksAi = /\b(ai[-\s]?generated|generated by ai|generated with ai|created by ai|created with ai|fully ai|artificial intelligence|synthetic (music|content|track|album|artist)|ai content)\b/i.test(text);
    if ((keyLooksAi && text) || valueLooksAi) {
      evidence.push({ path: pathText, value: text.slice(0, 240) });
    }
  }
}

function pickBestAlbumSearchResult(items, release) {
  if (!items.length) return null;

  const targetAlbum = normalizeText(release.albumName);
  const targetArtist = normalizeText(release.artistName);

  return items
    .map((item) => {
      const albumScore = similarity(targetAlbum, normalizeText(item.title || ""));
      const artistScore = similarity(targetArtist, normalizeText(item.artist?.name || ""));
      return { item, score: albumScore * 0.7 + artistScore * 0.3 };
    })
    .sort((a, b) => b.score - a.score)[0]?.item || items[0];
}

function extractSpotifyId(input, expectedType) {
  const trimmed = input.trim();
  if (/^[A-Za-z0-9]{22}$/.test(trimmed)) return trimmed;

  const uriMatch = trimmed.match(new RegExp(`spotify:${expectedType}:([A-Za-z0-9]{22})`));
  if (uriMatch) return uriMatch[1];

  try {
    const parsed = new URL(trimmed);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const idx = parts.indexOf(expectedType);
    const id = idx >= 0 ? parts[idx + 1] : "";
    return /^[A-Za-z0-9]{22}$/.test(id) ? id : "";
  } catch {
    return "";
  }
}

function dedupeAlbums(albums) {
  const seen = new Set();
  const result = [];
  for (const album of albums) {
    const key = `${normalizeText(album.name)}|${album.release_date || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(album);
  }
  return result;
}

function normalizedDate(date) {
  if (!date) return "0000-00-00";
  if (/^\d{4}$/.test(date)) return `${date}-00-00`;
  if (/^\d{4}-\d{2}$/.test(date)) return `${date}-00`;
  return date;
}

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\([^)]*\)|\[[^\]]*\]/g, "")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.88;
  const aWords = new Set(a.split(/\s+/));
  const bWords = new Set(b.split(/\s+/));
  const intersection = [...aWords].filter((word) => bWords.has(word)).length;
  const union = new Set([...aWords, ...bWords]).size || 1;
  return intersection / union;
}

function errorRelease(input, error) {
  return {
    source: "input",
    artistName: "",
    albumName: input,
    upc: "",
    releaseDate: "",
    spotifyAlbumId: "",
    spotifyUrl: "",
    spotifyLabel: "",
    tracks: [],
    error,
  };
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 15_000);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  return JSON.parse(text);
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data, null, 2));
}

function serveStatic(pathname, res) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404);
      return res.end("Not found");
    }

    res.writeHead(200, {
      "Content-Type": contentType(filePath),
      "Cache-Control": "no-store",
    });
    res.end(content);
  });
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  return "text/plain; charset=utf-8";
}
