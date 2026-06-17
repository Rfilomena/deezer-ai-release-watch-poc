const crypto = require("node:crypto");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");

loadEnvFile();

const PORT = Number(process.env.PORT || 5057);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = path.join(__dirname, "public");
const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
const SPOTIFY_API = "https://api.spotify.com/v1";
const DEEZER_API = "https://api.deezer.com";
const SPOTIFY_SCOPES = "playlist-read-private playlist-read-collaborative";

let spotifyAppToken = null;
let spotifyUserToken = null;
let pendingSpotifyState = "";

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/api/health") {
      return sendJson(res, 200, {
        ok: true,
        spotifyConfigured: hasSpotifyCredentials(),
        spotifySignedIn: Boolean(spotifyUserToken),
        spotifyRedirectUri: spotifyRedirectUri(req),
      });
    }

    if (req.method === "GET" && url.pathname === "/auth/spotify") {
      return redirectToSpotify(req, res);
    }

    if (req.method === "GET" && url.pathname === "/auth/spotify/callback") {
      return handleSpotifyCallback(req, res, url);
    }

    if (req.method === "POST" && url.pathname === "/api/logout") {
      spotifyUserToken = null;
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/scan-playlist") {
      const body = await readJson(req);
      const result = await scanPlaylist(body);
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
  console.log(`Spotify playlist AI label checker running at http://localhost:${PORT}`);
});

async function scanPlaylist(body) {
  const playlistInput = String(body.playlist || "").trim();
  const market = String(body.market || "US").trim().toUpperCase();
  const maxTracks = clamp(Number(body.maxTracks || 200), 1, 500);
  const playlistId = extractSpotifyId(playlistInput, "playlist");

  if (!playlistId) {
    throw new Error("Paste a valid Spotify playlist URI, URL, or ID.");
  }

  const playlist = await getSpotifyPlaylist(playlistId, market);
  const spotifyTracks = (await getSpotifyPlaylistTracks(playlistId, market, maxTracks))
    .filter((track) => track && !track.isLocal)
    .slice(0, maxTracks);

  const rows = [];
  for (const track of spotifyTracks) {
    rows.push(await enrichTrackWithDeezer(track));
  }

  const matched = rows.filter((row) => row.deezer.matched).length;
  const aiFound = rows.filter((row) => row.ai.status === "ai").length;
  const noAiLabel = rows.filter((row) => row.ai.status === "no_public_label").length;
  const noMatch = rows.filter((row) => row.ai.status === "unknown").length;

  return {
    playlist,
    rows,
    summary: {
      scanned: rows.length,
      matched,
      aiFound,
      noAiLabel,
      noMatch,
    },
  };
}

async function getSpotifyPlaylist(playlistId, market) {
  const data = await spotifyGet(
    `/playlists/${playlistId}?market=${encodeURIComponent(market)}&fields=id,name,external_urls,owner(display_name),tracks(total)`,
    { preferUserToken: true },
  );

  return {
    id: data.id,
    name: data.name || "Spotify playlist",
    owner: data.owner?.display_name || "",
    totalTracks: data.tracks?.total || 0,
    spotifyUrl: data.external_urls?.spotify || `https://open.spotify.com/playlist/${playlistId}`,
  };
}

async function getSpotifyPlaylistTracks(playlistId, market, maxTracks) {
  const tracks = [];
  let offset = 0;

  while (tracks.length < maxTracks) {
    const fields = [
      "total",
      "next",
      "items(track(id,type,is_local,name,external_ids,external_urls,artists(id,name),album(id,name,release_date,external_urls)))",
    ].join(",");
    const endpoint = `/playlists/${playlistId}/tracks?market=${encodeURIComponent(market)}&limit=100&offset=${offset}&fields=${encodeURIComponent(fields)}`;
    const data = await spotifyGet(endpoint, { preferUserToken: true });
    const items = data.items || [];

    for (const item of items) {
      const track = item.track;
      if (!track || track.type !== "track") continue;
      tracks.push({
        rowNumber: tracks.length + 1,
        spotifyTrackId: track.id || "",
        name: track.name || "",
        artistName: (track.artists || []).map((artist) => artist.name).join(", "),
        albumName: track.album?.name || "",
        albumDate: track.album?.release_date || "",
        isrc: track.external_ids?.isrc || "",
        spotifyUrl: track.external_urls?.spotify || "",
        albumUrl: track.album?.external_urls?.spotify || "",
        isLocal: Boolean(track.is_local),
      });
    }

    if (!data.next || !items.length) break;
    offset += items.length;
  }

  return tracks;
}

async function enrichTrackWithDeezer(spotifyTrack) {
  const match = await findDeezerTrack(spotifyTrack);

  if (!match.track) {
    return {
      spotify: spotifyTrack,
      deezer: {
        matched: false,
        method: match.method || "",
        error: match.error || "No Deezer match",
      },
      ai: {
        status: "unknown",
        label: "Unknown",
        evidence: [],
      },
    };
  }

  const inspected = await buildDeezerTrackInspectionPayload(match.track);
  const evidence = findAiEvidence(inspected);
  const hasAiEvidence = evidence.length > 0;

  return {
    spotify: spotifyTrack,
    deezer: {
      matched: true,
      method: match.method,
      trackId: match.track.id,
      title: match.track.title || match.track.title_short || "",
      artistName: match.track.artist?.name || "",
      albumTitle: match.track.album?.title || "",
      albumId: match.track.album?.id || "",
      link: match.track.link || "",
    },
    ai: {
      status: hasAiEvidence ? "ai" : "no_public_label",
      label: hasAiEvidence ? "AI" : "No AI label found",
      evidence,
    },
  };
}

async function findDeezerTrack(spotifyTrack) {
  const attempts = [];

  if (spotifyTrack.isrc) {
    attempts.push({
      method: "isrc",
      url: `${DEEZER_API}/track/isrc:${encodeURIComponent(spotifyTrack.isrc)}`,
    });
  }

  const strictQuery = `track:"${spotifyTrack.name}" artist:"${spotifyTrack.artistName}"`;
  attempts.push({
    method: "track-search-strict",
    url: `${DEEZER_API}/search/track?q=${encodeURIComponent(strictQuery)}&limit=5`,
    search: true,
  });
  attempts.push({
    method: "track-search-loose",
    url: `${DEEZER_API}/search/track?q=${encodeURIComponent(`${spotifyTrack.name} ${spotifyTrack.artistName}`)}&limit=5`,
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

      if (attempt.search) {
        const best = pickBestTrackSearchResult(data.data || [], spotifyTrack);
        if (best?.id) {
          const fullTrack = await deezerGet(`${DEEZER_API}/track/${best.id}`);
          if (!fullTrack?.error) return { track: fullTrack, method: attempt.method };
        }
      } else if (data?.id) {
        const fullTrack = await deezerGet(`${DEEZER_API}/track/${data.id}`);
        return { track: fullTrack?.error ? data : fullTrack, method: attempt.method };
      }
    } catch (error) {
      errors.push(`${attempt.method}: ${error.message}`);
    }
  }

  return { track: null, method: "", error: errors.join(" | ") };
}

async function buildDeezerTrackInspectionPayload(track) {
  const payload = { track };

  if (track.album?.id) {
    try {
      const album = await deezerGet(`${DEEZER_API}/album/${track.album.id}`);
      if (!album?.error) payload.album = album;
    } catch {
      // Album details are optional for this proof.
    }
  }

  if (track.artist?.id) {
    try {
      const artist = await deezerGet(`${DEEZER_API}/artist/${track.artist.id}`);
      if (!artist?.error) payload.artist = artist;
    } catch {
      // Artist details are optional for this proof.
    }
  }

  return payload;
}

async function spotifyGet(endpoint, options = {}) {
  const token = await getSpotifyToken(options);
  const response = await fetchWithTimeout(`${SPOTIFY_API}${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (response.status === 401 && spotifyUserToken) {
    spotifyUserToken = null;
  }

  if (!response.ok) {
    const text = await response.text();
    if (response.status === 403) {
      throw new Error("Spotify denied playlist access. Sign in with a Spotify account that owns or collaborates on this playlist, or try a different playlist.");
    }
    throw new Error(`Spotify API ${response.status}: ${text.slice(0, 240)}`);
  }

  return response.json();
}

async function getSpotifyToken(options = {}) {
  if (options.preferUserToken && spotifyUserToken) {
    return getSpotifyUserAccessToken();
  }
  return getSpotifyAppAccessToken();
}

async function getSpotifyUserAccessToken() {
  if (!spotifyUserToken) {
    throw new Error("Spotify sign-in is required for this playlist.");
  }

  if (spotifyUserToken.expiresAt > Date.now() + 60_000) {
    return spotifyUserToken.accessToken;
  }

  if (!spotifyUserToken.refreshToken) {
    spotifyUserToken = null;
    throw new Error("Spotify sign-in expired. Sign in again.");
  }

  const response = await fetchWithTimeout(SPOTIFY_TOKEN_URL, {
    method: "POST",
    headers: spotifyTokenHeaders(),
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: spotifyUserToken.refreshToken,
    }),
  });

  if (!response.ok) {
    spotifyUserToken = null;
    const text = await response.text();
    throw new Error(`Spotify token refresh failed ${response.status}: ${text.slice(0, 240)}`);
  }

  const data = await response.json();
  spotifyUserToken = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || spotifyUserToken.refreshToken,
    expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
  };
  return spotifyUserToken.accessToken;
}

async function getSpotifyAppAccessToken() {
  if (spotifyAppToken && spotifyAppToken.expiresAt > Date.now() + 60_000) {
    return spotifyAppToken.accessToken;
  }

  if (!hasSpotifyCredentials()) {
    throw new Error("Spotify credentials are not configured. Add SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET to .env or Replit Secrets.");
  }

  const response = await fetchWithTimeout(SPOTIFY_TOKEN_URL, {
    method: "POST",
    headers: spotifyTokenHeaders(),
    body: "grant_type=client_credentials",
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Spotify token request failed ${response.status}: ${text.slice(0, 240)}`);
  }

  const data = await response.json();
  spotifyAppToken = {
    accessToken: data.access_token,
    expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
  };
  return spotifyAppToken.accessToken;
}

function redirectToSpotify(req, res) {
  if (!hasSpotifyCredentials()) {
    return sendJson(res, 500, { error: "Spotify credentials are not configured." });
  }

  pendingSpotifyState = crypto.randomBytes(16).toString("hex");
  const url = new URL(SPOTIFY_AUTHORIZE_URL);
  url.searchParams.set("client_id", process.env.SPOTIFY_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", spotifyRedirectUri(req));
  url.searchParams.set("scope", SPOTIFY_SCOPES);
  url.searchParams.set("state", pendingSpotifyState);
  res.writeHead(302, { Location: url.toString() });
  res.end();
}

async function handleSpotifyCallback(req, res, url) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    res.writeHead(302, { Location: `/?spotify_error=${encodeURIComponent(error)}` });
    return res.end();
  }

  if (!code || !pendingSpotifyState || state !== pendingSpotifyState) {
    res.writeHead(302, { Location: "/?spotify_error=invalid_state" });
    return res.end();
  }

  pendingSpotifyState = "";
  const response = await fetchWithTimeout(SPOTIFY_TOKEN_URL, {
    method: "POST",
    headers: spotifyTokenHeaders(),
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: spotifyRedirectUri(req),
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    res.writeHead(302, { Location: `/?spotify_error=${encodeURIComponent(text.slice(0, 120))}` });
    return res.end();
  }

  const data = await response.json();
  spotifyUserToken = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
  };

  res.writeHead(302, { Location: "/" });
  res.end();
}

function spotifyRedirectUri(req) {
  if (process.env.SPOTIFY_REDIRECT_URI) return process.env.SPOTIFY_REDIRECT_URI;

  const proto = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}/auth/spotify/callback`;
}

function spotifyTokenHeaders() {
  const credentials = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString("base64");
  return {
    Authorization: `Basic ${credentials}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
}

function hasSpotifyCredentials() {
  return Boolean(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET);
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

function pickBestTrackSearchResult(items, spotifyTrack) {
  if (!items.length) return null;

  const targetTrack = normalizeText(spotifyTrack.name);
  const targetArtist = normalizeText(spotifyTrack.artistName);
  const targetAlbum = normalizeText(spotifyTrack.albumName);

  return items
    .map((item) => {
      const trackScore = similarity(targetTrack, normalizeText(item.title || item.title_short || ""));
      const artistScore = similarity(targetArtist, normalizeText(item.artist?.name || ""));
      const albumScore = similarity(targetAlbum, normalizeText(item.album?.title || ""));
      return { item, score: trackScore * 0.6 + artistScore * 0.3 + albumScore * 0.1 };
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
