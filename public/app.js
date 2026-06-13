const els = {
  status: document.querySelector("#status"),
  mode: document.querySelector("#mode"),
  market: document.querySelector("#market"),
  maxAlbums: document.querySelector("#maxAlbums"),
  input: document.querySelector("#input"),
  hint: document.querySelector("#hint"),
  scanButton: document.querySelector("#scanButton"),
  csvButton: document.querySelector("#csvButton"),
  results: document.querySelector("#results"),
  scanned: document.querySelector("#scanned"),
  matched: document.querySelector("#matched"),
  aiFound: document.querySelector("#aiFound"),
  noMatch: document.querySelector("#noMatch"),
};

let latestRows = [];

const modeHints = {
  manual: "Manual rows use Artist | Album | optional UPC. This mode is the fastest way to test whether Deezer exposes an album-level AI field.",
  "spotify-albums": "Paste one Spotify album link or ID per line. The scan uses Spotify UPC and track ISRCs to match Deezer.",
  "spotify-artists": "Paste one Spotify artist link or ID per line. The scan checks recent albums and singles for each artist.",
};

els.mode.addEventListener("change", () => {
  els.hint.textContent = modeHints[els.mode.value];
});

els.scanButton.addEventListener("click", runScan);
els.csvButton.addEventListener("click", exportCsv);

boot();

async function boot() {
  try {
    const res = await fetch("/api/health");
    const data = await res.json();
    els.status.textContent = data.spotifyConfigured ? "Spotify ready" : "Manual mode ready";
    els.status.className = `status ${data.spotifyConfigured ? "ok" : "warn"}`;
  } catch {
    els.status.textContent = "Server unavailable";
    els.status.className = "status warn";
  }
}

async function runScan() {
  els.scanButton.disabled = true;
  els.csvButton.disabled = true;
  els.scanButton.textContent = "Scanning...";
  renderLoading();

  try {
    const response = await fetch("/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: els.mode.value,
        input: els.input.value,
        market: els.market.value,
        maxAlbums: els.maxAlbums.value,
      }),
    });

    const data = await response.json();
    if (!response.ok || data.error) throw new Error(data.error || "Scan failed");

    latestRows = data.rows || [];
    renderSummary(data.summary || {});
    renderRows(latestRows);
    els.csvButton.disabled = latestRows.length === 0;
  } catch (error) {
    latestRows = [];
    renderError(error.message || "Scan failed");
  } finally {
    els.scanButton.disabled = false;
    els.scanButton.textContent = "Run Scan";
  }
}

function renderSummary(summary) {
  els.scanned.textContent = summary.scanned || 0;
  els.matched.textContent = summary.matched || 0;
  els.aiFound.textContent = summary.aiFound || 0;
  els.noMatch.textContent = summary.noMatch || 0;
}

function renderLoading() {
  els.results.innerHTML = `<tr><td colspan="7" class="empty">Scanning Deezer metadata...</td></tr>`;
  renderSummary({});
}

function renderError(message) {
  els.results.innerHTML = `<tr><td colspan="7" class="empty">${escapeHtml(message)}</td></tr>`;
  renderSummary({});
}

function renderRows(rows) {
  if (!rows.length) {
    els.results.innerHTML = `<tr><td colspan="7" class="empty">No rows to display.</td></tr>`;
    return;
  }

  els.results.innerHTML = rows.map((row) => {
    const release = row.release || {};
    const deezer = row.deezer || {};
    const ai = row.ai || {};
    const matchClass = deezer.matched ? "match" : "nomatch";
    const aiClass = ai.status === "found" ? "found" : "missing";

    return `
      <tr>
        <td>
          <strong>${escapeHtml(release.artistName || "Unknown")}</strong>
          <div class="muted">${escapeHtml(release.source || "")}</div>
        </td>
        <td>
          ${release.spotifyUrl ? `<a href="${escapeAttr(release.spotifyUrl)}" target="_blank" rel="noreferrer">${escapeHtml(release.albumName || "")}</a>` : escapeHtml(release.albumName || "")}
          <div class="muted">${escapeHtml(release.upc ? `UPC ${release.upc}` : "")}</div>
        </td>
        <td>${escapeHtml(release.releaseDate || "")}</td>
        <td>${escapeHtml(release.spotifyLabel || "")}</td>
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
  if (!evidence.length) return `<span class="muted">No AI-related public fields found.</span>`;
  return `<div class="evidence">${evidence.map((item) => `
    <code>${escapeHtml(item.path)} = ${escapeHtml(item.value)}</code>
  `).join("")}</div>`;
}

function exportCsv() {
  const rows = latestRows.map((row) => {
    const release = row.release || {};
    const deezer = row.deezer || {};
    const ai = row.ai || {};
    return {
      artist: release.artistName || "",
      album: release.albumName || "",
      releaseDate: release.releaseDate || "",
      spotifyLabel: release.spotifyLabel || "",
      spotifyAlbumId: release.spotifyAlbumId || "",
      upc: release.upc || "",
      deezerMatched: deezer.matched ? "yes" : "no",
      deezerMethod: deezer.method || "",
      deezerAlbumId: deezer.albumId || "",
      deezerLabel: deezer.label || "",
      aiStatus: ai.label || "",
      evidence: (ai.evidence || []).map((item) => `${item.path}=${item.value}`).join("; "),
    };
  });

  const header = Object.keys(rows[0] || { artist: "", album: "" });
  const csv = [
    header.join(","),
    ...rows.map((row) => header.map((key) => csvCell(row[key])).join(",")),
  ].join("\n");

  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `ai-release-watch-${new Date().toISOString().slice(0, 10)}.csv`;
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
