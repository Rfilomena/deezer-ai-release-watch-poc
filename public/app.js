const els = {
  status: document.querySelector("#status"),
  spotifyAuth: document.querySelector("#spotifyAuth"),
  playlist: document.querySelector("#playlist"),
  market: document.querySelector("#market"),
  maxTracks: document.querySelector("#maxTracks"),
  scanButton: document.querySelector("#scanButton"),
  csvButton: document.querySelector("#csvButton"),
  playlistMeta: document.querySelector("#playlistMeta"),
  results: document.querySelector("#results"),
  scanned: document.querySelector("#scanned"),
  matched: document.querySelector("#matched"),
  aiFound: document.querySelector("#aiFound"),
  noAiLabel: document.querySelector("#noAiLabel"),
};

let latestRows = [];
let latestPlaylist = null;

els.scanButton.addEventListener("click", runScan);
els.csvButton.addEventListener("click", exportCsv);

boot();

async function boot() {
  const params = new URLSearchParams(location.search);
  const spotifyError = params.get("spotify_error");
  if (spotifyError) {
    els.status.textContent = `Spotify sign-in failed: ${spotifyError}`;
    els.status.className = "status warn";
    history.replaceState(null, "", location.pathname);
    return;
  }

  try {
    const res = await fetch("/api/health");
    const data = await res.json();

    if (!data.spotifyConfigured) {
      els.status.textContent = "Add Spotify secrets";
      els.status.className = "status warn";
      els.spotifyAuth.hidden = true;
      return;
    }

    els.status.textContent = data.spotifySignedIn ? "Spotify signed in" : "Spotify ready";
    els.status.className = `status ${data.spotifySignedIn ? "ok" : "warn"}`;
    els.spotifyAuth.textContent = data.spotifySignedIn ? "Switch Spotify account" : "Sign in with Spotify";
  } catch {
    els.status.textContent = "Server unavailable";
    els.status.className = "status warn";
  }
}

async function runScan() {
  els.scanButton.disabled = true;
  els.csvButton.disabled = true;
  els.scanButton.textContent = "Scanning...";
  latestRows = [];
  latestPlaylist = null;
  renderPlaylist(null);
  renderLoading();

  try {
    const response = await fetch("/api/scan-playlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        playlist: els.playlist.value,
        market: els.market.value,
        maxTracks: els.maxTracks.value,
      }),
    });

    const data = await response.json();
    if (!response.ok || data.error) throw new Error(data.error || "Scan failed");

    latestRows = data.rows || [];
    latestPlaylist = data.playlist || null;
    renderPlaylist(latestPlaylist);
    renderSummary(data.summary || {});
    renderRows(latestRows);
    els.csvButton.disabled = latestRows.length === 0;
    await boot();
  } catch (error) {
    renderError(error.message || "Scan failed");
  } finally {
    els.scanButton.disabled = false;
    els.scanButton.textContent = "Scan Playlist";
  }
}

function renderPlaylist(playlist) {
  if (!playlist) {
    els.playlistMeta.hidden = true;
    els.playlistMeta.innerHTML = "";
    return;
  }

  els.playlistMeta.hidden = false;
  els.playlistMeta.innerHTML = `
    <div>
      <span>Playlist</span>
      <strong>${escapeHtml(playlist.name)}</strong>
    </div>
    <div>
      <span>Owner</span>
      <strong>${escapeHtml(playlist.owner || "Unknown")}</strong>
    </div>
    <div>
      <span>Total Tracks</span>
      <strong>${escapeHtml(playlist.totalTracks || 0)}</strong>
    </div>
    <a href="${escapeAttr(playlist.spotifyUrl)}" target="_blank" rel="noreferrer">Open in Spotify</a>
  `;
}

function renderSummary(summary) {
  els.scanned.textContent = summary.scanned || 0;
  els.matched.textContent = summary.matched || 0;
  els.aiFound.textContent = summary.aiFound || 0;
  els.noAiLabel.textContent = summary.noAiLabel || 0;
}

function renderLoading() {
  els.results.innerHTML = `<tr><td colspan="8" class="empty">Scanning Spotify tracks and matching Deezer metadata...</td></tr>`;
  renderSummary({});
}

function renderError(message) {
  els.results.innerHTML = `<tr><td colspan="8" class="empty">${escapeHtml(message)}</td></tr>`;
  renderSummary({});
}

function renderRows(rows) {
  if (!rows.length) {
    els.results.innerHTML = `<tr><td colspan="8" class="empty">No tracks to display.</td></tr>`;
    return;
  }

  els.results.innerHTML = rows.map((row) => {
    const spotify = row.spotify || {};
    const deezer = row.deezer || {};
    const ai = row.ai || {};
    const matchClass = deezer.matched ? "match" : "nomatch";
    const aiClass = ai.status === "ai" ? "found" : ai.status === "no_public_label" ? "missing" : "unknown";

    return `
      <tr>
        <td>${escapeHtml(spotify.rowNumber || "")}</td>
        <td>
          ${spotify.spotifyUrl ? `<a href="${escapeAttr(spotify.spotifyUrl)}" target="_blank" rel="noreferrer">${escapeHtml(spotify.name || "")}</a>` : escapeHtml(spotify.name || "")}
        </td>
        <td>${escapeHtml(spotify.artistName || "")}</td>
        <td>
          ${spotify.albumUrl ? `<a href="${escapeAttr(spotify.albumUrl)}" target="_blank" rel="noreferrer">${escapeHtml(spotify.albumName || "")}</a>` : escapeHtml(spotify.albumName || "")}
          <div class="muted">${escapeHtml(spotify.albumDate || "")}</div>
        </td>
        <td><code>${escapeHtml(spotify.isrc || "")}</code></td>
        <td>
          <span class="pill ${matchClass}">${deezer.matched ? "Matched" : "No match"}</span>
          <div class="muted">${escapeHtml(deezer.method || deezer.error || "")}</div>
          ${deezer.link ? `<div><a href="${escapeAttr(deezer.link)}" target="_blank" rel="noreferrer">Open Deezer</a></div>` : ""}
        </td>
        <td><span class="pill ${aiClass}">${escapeHtml(ai.label || "Unknown")}</span></td>
        <td>${renderEvidence(ai.evidence || [])}</td>
      </tr>
    `;
  }).join("");
}

function renderEvidence(evidence) {
  if (!evidence.length) return `<span class="muted">No public AI-label field found.</span>`;
  return `<div class="evidence">${evidence.map((item) => `
    <code>${escapeHtml(item.path)} = ${escapeHtml(item.value)}</code>
  `).join("")}</div>`;
}

function exportCsv() {
  const rows = latestRows.map((row) => {
    const spotify = row.spotify || {};
    const deezer = row.deezer || {};
    const ai = row.ai || {};
    return {
      playlist: latestPlaylist?.name || "",
      trackNumber: spotify.rowNumber || "",
      song: spotify.name || "",
      artist: spotify.artistName || "",
      album: spotify.albumName || "",
      isrc: spotify.isrc || "",
      spotifyUrl: spotify.spotifyUrl || "",
      deezerMatched: deezer.matched ? "yes" : "no",
      deezerMethod: deezer.method || "",
      deezerTrackId: deezer.trackId || "",
      deezerUrl: deezer.link || "",
      aiStatus: ai.label || "",
      evidence: (ai.evidence || []).map((item) => `${item.path}=${item.value}`).join("; "),
    };
  });

  const header = Object.keys(rows[0] || { song: "", artist: "" });
  const csv = [
    header.join(","),
    ...rows.map((row) => header.map((key) => csvCell(row[key])).join(",")),
  ].join("\n");

  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `spotify-playlist-ai-labels-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function csvCell(value) {
  const text = String(value || "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}
