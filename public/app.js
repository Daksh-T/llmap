/* ─────────────────────────────────────────────────────────
   LOCATING LEGACIES ATLAS
   ───────────────────────────────────────────────────────── */

const map = L.map("map", { zoomControl: false, minZoom: 3, preferCanvas: true })
  .setView([37.8, -96], 4);

const basePane = map.createPane("basemap-base");
basePane.classList.add("map-base-pane");
basePane.style.zIndex = "200";

const labelsPane = map.createPane("basemap-labels");
labelsPane.classList.add("map-labels-pane");
labelsPane.style.zIndex = "240";

L.control.zoom({ position: "topright" }).addTo(map);

const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>' +
  ' &copy; <a href="https://carto.com/attributions">CARTO</a>';

const BASEMAPS = {
  dark: {
    base: {
      url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}{r}.png",
      options: { attribution: TILE_ATTRIBUTION, subdomains: "abcd", maxZoom: 19, pane: "basemap-base" },
    },
    labels: {
      url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}{r}.png",
      options: { attribution: "", subdomains: "abcd", maxZoom: 19, pane: "basemap-labels" },
    },
  },
  light: {
    base: {
      url: "https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png",
      options: { attribution: TILE_ATTRIBUTION, subdomains: "abcd", maxZoom: 19, pane: "basemap-base" },
    },
    labels: {
      url: "https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png",
      options: { attribution: "", subdomains: "abcd", maxZoom: 19, pane: "basemap-labels" },
    },
  },
};

let baseLayer = null;
let labelsLayer = null;

const layerGroup = L.layerGroup().addTo(map);

/* ── State ────────────────────────────────────────────── */

const state = { records: [], filtered: [], selectedId: null, markers: new Map(), markerGroups: [] };

const THEMES = ["dark", "light"];
const THEME_STORAGE_KEY = "llmap-theme";

/* ── Element refs ─────────────────────────────────────── */

const $ = (id) => document.getElementById(id);

const el = {
  mappedCount: $("mapped-count"),
  institutionCount: $("institution-count"),
  fetchedAt: $("fetched-at"),
  featureCard: $("feature-card"),
  resultsList: $("results-list"),
  resultsNote: $("results-note"),
  searchInput: $("search-input"),
  typeFilter: $("type-filter"),
  themeDarkBtn: $("theme-dark-btn"),
  themeLightBtn: $("theme-light-btn"),
  // Modals
  instModal: $("inst-modal"), instList: $("inst-list"),
  instSearch: $("inst-search"), instClose: $("inst-close"), instBackdrop: $("inst-backdrop"),
  catalog: $("catalog"), catalogGrid: $("catalog-grid"),
  catalogSearch: $("catalog-search"), catalogClose: $("catalog-close"),
  catalogCount: $("catalog-count"),
  // Resize
  dossier: $("dossier"), dossierHandle: $("dossier-handle"),
};

/* ── Type colours ─────────────────────────────────────── */

const COLOURS = [
  "#e8903a","#e86464","#5ab8e0","#72c47a",
  "#c47ecf","#e0c04a","#50c8a8","#e07898",
  "#7898e0","#d4784a",
];
const _cc = new Map();
function typeColor(t) {
  if (!t) return COLOURS[0];
  if (_cc.has(t)) return _cc.get(t);
  let h = 0;
  for (let i = 0; i < t.length; i++) h = (Math.imul(31, h) + t.charCodeAt(i)) | 0;
  const c = COLOURS[Math.abs(h) % COLOURS.length];
  _cc.set(t, c);
  return c;
}

/* ── Helpers ──────────────────────────────────────────── */

function esc(v) {
  return String(v)
    .replaceAll("&","&amp;").replaceAll("<","&lt;")
    .replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;");
}

function fmtDate(v) {
  return new Date(v).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function isTypingTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target.tagName);
}

function readStoredTheme() {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredTheme(theme) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {}
}

function syncThemeButtons(theme) {
  [el.themeDarkBtn, el.themeLightBtn].forEach((button) => {
    if (!button) return;
    const active = button.dataset.themeValue === theme;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function mountBaseLayer(theme) {
  const config = BASEMAPS[theme] || BASEMAPS.dark;
  if (baseLayer) map.removeLayer(baseLayer);
  if (labelsLayer) map.removeLayer(labelsLayer);
  baseLayer = L.tileLayer(config.base.url, config.base.options);
  labelsLayer = L.tileLayer(config.labels.url, config.labels.options);
  baseLayer.addTo(map);
  labelsLayer.addTo(map);
}

function applyTheme(theme, { persist = true } = {}) {
  if (!THEMES.includes(theme)) return;
  if (persist) writeStoredTheme(theme);
  document.body.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  syncThemeButtons(theme);
  mountBaseLayer(theme);
}

function resolveInitialTheme() {
  const storedTheme = readStoredTheme();
  if (THEMES.includes(storedTheme)) return storedTheme;
  const mediaQuery = window.matchMedia?.("(prefers-color-scheme: light)");
  return mediaQuery?.matches ? "light" : "dark";
}

/* ═══════════════════════════════════════════════════════
   MAP MARKERS  (exact-overlap stacks, no counts)
   ═══════════════════════════════════════════════════════ */

function markerGroupKey(rec) {
  return `${rec.lat}|${rec.lng}`;
}

function getMarkerBaseRecord(records) {
  return records.find((rec) => rec.id === state.selectedId) ?? records[0];
}

function markerIcon(records, active) {
  const base = getMarkerBaseRecord(records);
  const size = records.length > 1 ? (active ? 28 : 24) : (active ? 20 : 14);
  const echoes = records.length > 1
    ? Array.from({ length: Math.min(records.length - 1, 3) }, (_, index) =>
        `<span class="atlas-marker-echo echo-${index + 1}"></span>`,
      ).join("")
    : "";

  return L.divIcon({
    className: "atlas-marker-shell",
    html: `
      <div
        class="atlas-marker${active ? " is-active" : ""}${records.length > 1 ? " is-stack" : ""}"
        style="--marker-color:${typeColor(base.type)}; --marker-size:${size}px"
      >
        ${echoes}
        <span class="atlas-marker-core"></span>
      </div>`,
    iconSize: [size + 20, size + 20],
    iconAnchor: [(size + 20) / 2, (size + 20) / 2],
    tooltipAnchor: [0, -(size / 2 + 6)],
  });
}

function markerTooltip(records) {
  const base = getMarkerBaseRecord(records);
  const loc = base.label || base.place || base.spatial || "Mapped memorial";
  const overlapNote = records.length > 1
    ? `<br>${records.length - 1} other memorial${records.length > 2 ? "s" : ""} share this exact point`
    : "";
  return `<strong>${esc(base.title)}</strong>${esc(loc)}${overlapNote}`;
}

function nextMarkerRecord(records) {
  if (records.length === 1) return records[0];
  const currentIndex = records.findIndex((rec) => rec.id === state.selectedId);
  if (currentIndex < 0) return records[0];
  return records[(currentIndex + 1) % records.length];
}

function updateMarkerStyles() {
  state.markerGroups.forEach(({ marker, records }) => {
    const active = records.some((rec) => rec.id === state.selectedId);
    marker.setIcon(markerIcon(records, active));
    marker.setTooltipContent(markerTooltip(records));
    if (active) {
      marker.openTooltip();
      marker.setZIndexOffset(1000);
    } else {
      marker.closeTooltip();
      marker.setZIndexOffset(0);
    }
  });
}

function rebuildMarkers() {
  layerGroup.clearLayers();
  state.markers.clear();
  state.markerGroups = [];
  const bounds = [];
  const grouped = new Map();

  state.filtered.forEach((rec) => {
    const key = markerGroupKey(rec);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(rec);
    bounds.push([rec.lat, rec.lng]);
  });

  grouped.forEach((records) => {
    const base = getMarkerBaseRecord(records);
    const active = records.some((rec) => rec.id === state.selectedId);
    const marker = L.marker([base.lat, base.lng], {
      icon: markerIcon(records, active),
      keyboard: false,
    });

    marker.bindTooltip(markerTooltip(records), { sticky: true, direction: "top" });
    marker.on("click", () => selectRecord(nextMarkerRecord(records).id, false));
    marker.addTo(layerGroup);

    state.markerGroups.push({ marker, records });
    records.forEach((rec) => state.markers.set(rec.id, marker));
  });

  if (bounds.length) map.fitBounds(bounds, { padding: [42, 42] });
}

function getSelectionZoom(rec) {
  const distances = state.filtered
    .filter((entry) => entry.id !== rec.id)
    .map((entry) => map.distance([rec.lat, rec.lng], [entry.lat, entry.lng]))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  const nearest = distances[0] ?? Number.POSITIVE_INFINITY;
  const nearby250m = distances.filter((d) => d <= 250).length;
  const nearby1km = distances.filter((d) => d <= 1000).length;
  const nearby5km = distances.filter((d) => d <= 5000).length;
  const nearby25km = distances.filter((d) => d <= 25000).length;

  if (nearby250m >= 3 || nearest <= 120) return 17;
  if (nearby1km >= 4 || nearest <= 800) return 16;
  if (nearby5km >= 5 || nearest <= 3500) return 15;
  if (nearby25km >= 7 || nearest <= 12000) return 13;
  return 11;
}

/* ═══════════════════════════════════════════════════════
   DOSSIER: RECORD VIEW
   — flowing metadata, no table, expandable description
   ═══════════════════════════════════════════════════════ */

const DESC_LIMIT = 380;

function renderFeature(rec) {
  if (!rec) {
    el.featureCard.innerHTML = `
      <div class="record-empty">
        <span class="record-empty-glyph">&#9670;</span>
        <p>Select a memorial to examine its archival record.</p>
      </div>`;
    return;
  }

  const place = rec.place || rec.label || rec.spatial || "—";
  const showInstitution = rec.spatial && place !== rec.spatial;
  const typeValues = rec.types?.length ? rec.types : (rec.type ? [rec.type] : []);
  const contextValues = rec.contexts?.length ? rec.contexts : (rec.scope ? [rec.scope] : []);
  const periodValues = rec.periods?.length ? rec.periods : (rec.temporal ? [rec.temporal] : []);
  const fullDesc = rec.description || "No public description was provided in the source record.";
  const clipped  = fullDesc.length > DESC_LIMIT;
  const preview  = clipped ? fullDesc.slice(0, DESC_LIMIT).trimEnd() + "\u2026" : fullDesc;

  const img = rec.image
    ? `<div class="record-img-wrap"><img class="record-img" src="${esc(rec.image)}" alt="${esc(rec.title)}" /></div>`
    : "";

  const typeBadge = typeValues.length
    ? `<div class="record-type-badge">
         <span class="record-type-dot" style="background:${typeColor(rec.type)}"></span>
         <span class="record-type-name">${esc(typeValues.join(" · "))}</span>
       </div>`
    : "";

  const fields = [
    { l: "Location",    v: esc(place) },
    rec.classification ? { l: "Legacies Classification", v: esc(rec.classification) } : null,
    contextValues.length ? { l: "Memorial Context", v: esc(contextValues.join(" · ")) } : null,
    periodValues.length ? { l: "Period", v: esc(periodValues.join(" · ")) } : null,
    showInstitution ? { l: "Institution", v: esc(rec.spatial) } : null,
  ].filter(Boolean).map(
    ({ l, v }) =>
      `<div class="detail-field"><span class="detail-label">${l}</span><span class="detail-value">${v}</span></div>`,
  ).join("");

  const people = rec.people?.length
    ? `<div class="detail-field">
         <span class="detail-label">Memorialized</span>
         <div class="detail-people">
           ${rec.people.map((p) => `<span class="detail-person">${esc(p)}</span>`).join("")}
         </div>
       </div>`
    : "";

  el.featureCard.innerHTML = `
    ${img}
    <div class="record-body">
      <span class="record-eyebrow">Source Item &middot; #${rec.id}</span>
      ${typeBadge}
      <h2 class="record-title">${esc(rec.title)}</h2>
      <p class="record-desc" id="feat-desc">${esc(preview)}</p>
      ${clipped ? `<button class="record-expand" id="feat-expand">Show full description &rarr;</button>` : ""}
      <div class="record-divider"></div>
      <div class="record-details">
        ${fields}
        ${people}
      </div>
      <div class="record-actions">
        <a class="record-link primary" href="${esc(rec.itemUrl)}" target="_blank" rel="noreferrer">Open source record</a>
        <span class="record-id">ID&middot;${rec.id}</span>
      </div>
    </div>`;

  // Expand / collapse
  if (clipped) {
    const btn = $("feat-expand"), desc = $("feat-desc");
    let open = false;
    btn.addEventListener("click", () => {
      open = !open;
      desc.textContent = open ? fullDesc : preview;
      btn.innerHTML = open ? "Show less &larr;" : "Show full description &rarr;";
    });
  }
}

/* ═══════════════════════════════════════════════════════
   LEDGER
   ═══════════════════════════════════════════════════════ */

function renderResults() {
  el.resultsNote.textContent = `${state.filtered.length} entries`;
  el.resultsList.innerHTML = state.filtered.slice(0, 80).map((r, i) => {
    const a    = r.id === state.selectedId ? " is-active" : "";
    const tags = [r.type, r.spatial].filter(Boolean).slice(0, 2);
    const n    = String(i + 1).padStart(3, "0");
    const d    = Math.min(i * 15, 550);
    return `
      <article class="ledger-entry${a}" data-id="${r.id}" data-idx="${n}" style="animation-delay:${d}ms">
        <h3 class="entry-title">${esc(r.title)}</h3>
        <p class="entry-loc">${esc(r.label || r.place || r.spatial || "—")}</p>
        <div class="entry-tags">${tags.map((t) => `<span class="entry-tag">${esc(t)}</span>`).join("")}</div>
      </article>`;
  }).join("");

  el.resultsList.querySelector(".is-active")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  el.resultsList.querySelectorAll(".ledger-entry").forEach((c) =>
    c.addEventListener("click", () => selectRecord(Number(c.dataset.id), true)),
  );
}

/* ═══════════════════════════════════════════════════════
   SELECTION + FILTERING
   ═══════════════════════════════════════════════════════ */

function selectRecord(id, pan = false) {
  const rec = state.filtered.find((r) => r.id === id) || state.records.find((r) => r.id === id);
  state.selectedId = rec?.id ?? null;
  renderFeature(rec ?? null);
  renderResults();
  updateMarkerStyles();
  if (pan && rec) {
    map.flyTo([rec.lat, rec.lng], getSelectionZoom(rec), { duration: 0.7 });
  }
}

function applyFilters() {
  const q = el.searchInput.value.trim().toLowerCase();
  const t = el.typeFilter.value;
  state.filtered = state.records.filter((r) => {
    const hay = [
      r.title,
      r.description,
      r.place,
      r.label,
      r.spatial,
      ...(r.types || []),
      ...(r.contexts || []),
      ...(r.periods || []),
      ...(r.people || []),
    ]
      .filter(Boolean).join(" ").toLowerCase();
    return (!q || hay.includes(q)) && (t === "all" || (r.types?.length ? r.types.includes(t) : r.type === t));
  });
  rebuildMarkers();
  renderResults();
  if (!state.filtered.some((r) => r.id === state.selectedId))
    selectRecord(state.filtered[0]?.id ?? null, false);
  else updateMarkerStyles();
}

/* ═══════════════════════════════════════════════════════
   FULL-PAGE CATALOG  (all artifacts, instant search)
   ═══════════════════════════════════════════════════════ */

function renderCatalogCards(list) {
  if (!list.length) {
    el.catalogGrid.innerHTML = `<p class="catalog-empty">No memorials match your search.</p>`;
    return;
  }
  el.catalogGrid.innerHTML = list.map((r) => {
    const siteLabel = r.label || r.place || r.spatial || null;
    const showRecordTitle = siteLabel && siteLabel !== r.title;
    const thumb = r.image
      ? `<img class="cat-thumb" src="${esc(r.image)}" alt="" loading="lazy" />`
      : `<div class="cat-placeholder"><div class="cat-ph-dot" style="background:${typeColor(r.type)}"></div></div>`;
    return `
      <div class="cat-card" data-id="${r.id}" tabindex="0">
        ${thumb}
        <div class="cat-body">
          <h3 class="cat-title">${esc(siteLabel || r.title)}</h3>
          ${showRecordTitle ? `<p class="cat-record">${esc(r.title)}</p>` : ""}
          <div class="cat-meta">
            <span class="cat-dot" style="background:${typeColor(r.type)}"></span>
            <span>${esc(r.type || "Unclassified")}</span>
          </div>
          <span class="cat-loc">${esc(r.spatial || siteLabel || "—")}</span>
        </div>
      </div>`;
  }).join("");

  el.catalogGrid.querySelectorAll(".cat-card").forEach((c) => {
    const openCard = () => {
      const id = Number(c.dataset.id);
      closeCatalog();
      selectRecord(id, true);
    };
    c.addEventListener("click", openCard);
    c.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openCard();
      }
    });
  });
}

function openCatalog() {
  el.catalogCount.textContent = `${state.records.length} records`;
  el.catalogSearch.value = "";
  renderCatalogCards(state.records);
  el.catalog.removeAttribute("hidden");
  el.catalogSearch.focus();
}

function closeCatalog() {
  el.catalog.setAttribute("hidden", "");
}

el.catalogSearch?.addEventListener("input", () => {
  const q = el.catalogSearch.value.trim().toLowerCase();
  if (!q) { renderCatalogCards(state.records); return; }
  renderCatalogCards(
    state.records.filter((r) => {
      const hay = [
        r.title,
        r.description,
        r.place,
        r.label,
        r.spatial,
        ...(r.types || []),
        ...(r.contexts || []),
        ...(r.periods || []),
        ...(r.people || []),
      ]
        .filter(Boolean).join(" ").toLowerCase();
      return hay.includes(q);
    }),
  );
});

$("mapped-btn")?.addEventListener("click", openCatalog);
$("catalog-close")?.addEventListener("click", closeCatalog);
[el.themeDarkBtn, el.themeLightBtn].forEach((button) =>
  button?.addEventListener("click", () => applyTheme(button.dataset.themeValue)),
);

window.matchMedia?.("(prefers-color-scheme: light)")?.addEventListener?.("change", (event) => {
  if (readStoredTheme()) return;
  applyTheme(event.matches ? "light" : "dark", { persist: false });
});

/* ═══════════════════════════════════════════════════════
   INSTITUTIONS OVERLAY
   ═══════════════════════════════════════════════════════ */

function openInstitutions() {
  const counts = new Map();
  for (const r of state.records) if (r.spatial) counts.set(r.spatial, (counts.get(r.spatial) || 0) + 1);
  const all = [...counts.entries()].sort((a, b) => b[1] - a[1]);

  function render(list) {
    el.instList.innerHTML = list.map(([name, count]) => {
      const url = "https://locatinglegacies.org/s/hub/search?fulltext_search=" + encodeURIComponent(name);
      return `
        <div class="inst-row" data-inst="${esc(name)}">
          <div class="inst-info">
            <span class="inst-name">${esc(name)}</span>
            <span class="inst-count">${count} memorial${count !== 1 ? "s" : ""}</span>
          </div>
          <a class="inst-ext-link" href="${esc(url)}" target="_blank" rel="noreferrer" onclick="event.stopPropagation()">&nearr;</a>
        </div>`;
    }).join("");
    el.instList.querySelectorAll(".inst-row").forEach((row) =>
      row.addEventListener("click", () => {
        el.searchInput.value = row.dataset.inst;
        applyFilters();
        closeInstitutions();
      }),
    );
  }

  render(all);
  el.instSearch.value = "";
  el.instSearch.oninput = () => {
    const q = el.instSearch.value.trim().toLowerCase();
    render(q ? all.filter(([n]) => n.toLowerCase().includes(q)) : all);
  };
  el.instModal.removeAttribute("hidden");
  el.instSearch.focus();
}

function closeInstitutions() { el.instModal.setAttribute("hidden", ""); }

$("inst-btn")?.addEventListener("click", openInstitutions);
el.instClose?.addEventListener("click", closeInstitutions);
el.instBackdrop?.addEventListener("click", closeInstitutions);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { closeInstitutions(); closeCatalog(); }
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  if (isTypingTarget(event.target)) return;
  if (!el.catalog.hasAttribute("hidden") || !el.instModal.hasAttribute("hidden")) return;
  if (!state.filtered.length) return;

  const currentIndex = state.filtered.findIndex((entry) => entry.id === state.selectedId);
  const startIndex = currentIndex >= 0 ? currentIndex : 0;
  const delta = event.key === "ArrowDown" ? 1 : -1;
  const nextIndex = Math.max(0, Math.min(state.filtered.length - 1, startIndex + delta));
  if (nextIndex === currentIndex) return;

  event.preventDefault();
  selectRecord(state.filtered[nextIndex].id, true);
});

/* ═══════════════════════════════════════════════════════
   DOSSIER RESIZE
   ═══════════════════════════════════════════════════════ */

{
  const d = el.dossier, h = el.dossierHandle;
  let dragging = false, sx = 0, sw = 0;
  h?.addEventListener("mousedown", (e) => {
    dragging = true; sx = e.clientX; sw = d.offsetWidth;
    h.classList.add("dragging");
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    d.style.width = Math.max(280, Math.min(640, sw + (sx - e.clientX))) + "px";
  });
  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    h.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  });
}

/* ═══════════════════════════════════════════════════════
   BOOT
   ═══════════════════════════════════════════════════════ */

el.searchInput.addEventListener("input", applyFilters);
el.typeFilter.addEventListener("change", applyFilters);
applyTheme(resolveInitialTheme(), { persist: false });

(async () => {
  try {
    const res = await fetch("/api/legacies");
    if (!res.ok) throw new Error("Failed");
    const { meta, records } = await res.json();
    state.records = records;
    state.filtered = records;

    const types = [...new Set(records.flatMap((r) => r.types?.length ? r.types : (r.type ? [r.type] : [])))].sort();
    el.typeFilter.innerHTML =
      `<option value="all">All types</option>` +
      types.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join("");

    el.mappedCount.textContent = String(meta.mappedItems);
    el.institutionCount.textContent = String(meta.institutions);
    el.fetchedAt.textContent = `Live · ${fmtDate(meta.fetchedAt)}`;

    applyFilters();
    selectRecord(state.filtered[0]?.id ?? null, false);
  } catch (err) {
    console.error(err);
    el.featureCard.innerHTML = `
      <div class="record-empty">
        <span class="record-empty-glyph">&#9888;</span>
        <p>Live data fetch failed. Check server logs.</p>
      </div>`;
    el.fetchedAt.textContent = "Unavailable";
  }
})();
