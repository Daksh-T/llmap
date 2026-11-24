/* ─────────────────────────────────────────────────────────
   LOCATING LEGACIES ATLAS
   ───────────────────────────────────────────────────────── */

const map = L.map("map", { zoomControl: false, minZoom: 3, maxZoom: 20, preferCanvas: true })
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
      options: { attribution: TILE_ATTRIBUTION, subdomains: "abcd", maxZoom: 20, maxNativeZoom: 19, pane: "basemap-base" },
    },
    labels: {
      url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}{r}.png",
      options: { attribution: "", subdomains: "abcd", maxZoom: 20, maxNativeZoom: 19, pane: "basemap-labels" },
    },
  },
  light: {
    base: {
      url: "https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png",
      options: { attribution: TILE_ATTRIBUTION, subdomains: "abcd", maxZoom: 20, maxNativeZoom: 19, pane: "basemap-base" },
    },
    labels: {
      url: "https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png",
      options: { attribution: "", subdomains: "abcd", maxZoom: 20, maxNativeZoom: 19, pane: "basemap-labels" },
    },
  },
};

let baseLayer = null;
let labelsLayer = null;
let cartoApiKey = "";
let configReady = false;

function withCartoKey(url) {
  return cartoApiKey ? `${url}?key=${encodeURIComponent(cartoApiKey)}` : url;
}

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
  // Ledger
  ledger: document.querySelector(".ledger"),
  ledgerToggle: $("ledger-toggle"),
  // Modals
  instModal: $("inst-modal"), instList: $("inst-list"),
  instSearch: $("inst-search"), instClose: $("inst-close"), instBackdrop: $("inst-backdrop"),
  catalog: $("catalog"), catalogGrid: $("catalog-grid"),
  catalogSearch: $("catalog-search"), catalogClose: $("catalog-close"),
  catalogCount: $("catalog-count"),
  // Resize
  dossier: $("dossier"), dossierScroll: document.querySelector(".dossier-scroll"),
  dossierHandle: $("dossier-handle"),
  dossierClose: $("dossier-close"),
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

function buildHaystack(r) {
  return [r.title, r.description, r.place, r.label, r.spatial,
    ...(r.types || []), ...(r.contexts || []), ...(r.periods || []), ...(r.people || [])]
    .filter(Boolean).join(" ").toLowerCase();
}

function scrollToActive(block = "nearest") {
  const active = el.resultsList.querySelector(".is-active");
  if (!(active instanceof HTMLElement)) return;

  // Walk up from the active element to find the scroll container
  let container = active.parentElement;
  while (container && container !== document.body) {
    if (container.scrollHeight > container.clientHeight + 2) break;
    container = container.parentElement;
  }
  if (!(container instanceof HTMLElement)) return;

  // Compute the active entry's top relative to the scrolling container.
  let activeTop = active.offsetTop;
  let offsetParent = active.offsetParent;
  while (offsetParent && offsetParent !== container) {
    activeTop += offsetParent.offsetTop;
    offsetParent = offsetParent.offsetParent;
  }
  const activeBottom = activeTop + active.offsetHeight;
  const viewTop = container.scrollTop;
  const viewBottom = viewTop + container.clientHeight;

  let nextScrollTop;
  if (block === "center") {
    nextScrollTop = activeTop - (container.clientHeight / 2) + (active.offsetHeight / 2);
  } else {
    if (activeTop < viewTop) nextScrollTop = activeTop - 8;
    else if (activeBottom > viewBottom) nextScrollTop = activeBottom - container.clientHeight + 8;
    else return;
  }

  container.scrollTo({ top: Math.max(0, nextScrollTop), behavior: "smooth" });
}

function esc(v) {
  return String(v)
    .replaceAll("&","&amp;").replaceAll("<","&lt;")
    .replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;");
}

function fmtDate(v) {
  return new Date(v).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function safeRecordId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
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
  if (!configReady) return;
  const config = BASEMAPS[theme] || BASEMAPS.dark;
  if (baseLayer) map.removeLayer(baseLayer);
  if (labelsLayer) map.removeLayer(labelsLayer);
  baseLayer = L.tileLayer(withCartoKey(config.base.url), config.base.options);
  labelsLayer = L.tileLayer(withCartoKey(config.labels.url), config.labels.options);
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
   MAP MARKERS  (proximity-grouped stacks with cycling)
   ═══════════════════════════════════════════════════════ */

// ~55m at US latitudes — groups same-building/adjacent memorials
const PROXIMITY_THRESHOLD = 0.0005;

function groupRecordsByProximity(records) {
  const groups = [];
  const assigned = new Set();

  for (const rec of records) {
    if (assigned.has(rec.id)) continue;
    const group = [rec];
    assigned.add(rec.id);

    // Keep scanning: each newly added member can pull in more neighbours
    for (let gi = 0; gi < group.length; gi++) {
      const member = group[gi];
      for (const other of records) {
        if (assigned.has(other.id)) continue;
        if (
          Math.abs(member.lat - other.lat) < PROXIMITY_THRESHOLD &&
          Math.abs(member.lng - other.lng) < PROXIMITY_THRESHOLD
        ) {
          group.push(other);
          assigned.add(other.id);
        }
      }
    }

    groups.push(group);
  }

  return groups;
}

function getMarkerBaseRecord(records) {
  return records.find((rec) => rec.id === state.selectedId) ?? records[0];
}

function markerIcon(records, active, base) {
  if (!base) base = getMarkerBaseRecord(records);
  const stackExtra = Math.min(records.length - 1, 8) * 1.5;
  const size = records.length === 1
    ? (active ? 20 : 14)
    : Math.round((active ? 24 : 18) + stackExtra);

  // Each echo uses the actual type color of a different record in the group
  const others = records.filter((r) => r !== base);
  const echoes = others.length > 0
    ? others.slice(0, 3).map((rec, index) =>
        `<span class="atlas-marker-echo echo-${index + 1}" style="--echo-color:${typeColor(rec.type)}"></span>`,
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
    ? `<br>${records.length - 1} other memorial${records.length > 2 ? "s" : ""} nearby &middot; click to cycle`
    : "";
  return `<strong>${esc(base.title)}</strong>${esc(loc)}${overlapNote}`;
}

function nextMarkerRecord(records) {
  if (records.length === 1) return records[0];
  const currentIndex = records.findIndex((rec) => rec.id === state.selectedId);
  if (currentIndex < 0) return records[0];
  return records[(currentIndex + 1) % records.length];
}

function updateMarkerStyles(prevId) {
  for (const { marker, records } of state.markerGroups) {
    const hadPrev = prevId != null && records.some((rec) => rec.id === prevId);
    const hasNew = state.selectedId != null && records.some((rec) => rec.id === state.selectedId);
    if (!hadPrev && !hasNew) continue;
    const active = hasNew;
    marker.setIcon(markerIcon(records, active));
    marker.setTooltipContent(markerTooltip(records));
    marker.setZIndexOffset(active ? 1000 : 0);
  }
}

function rebuildMarkers(precomputedGroups, fitView = false) {
  layerGroup.clearLayers();
  state.markers.clear();
  state.markerGroups = [];
  const bounds = [];

  const groups = precomputedGroups || groupRecordsByProximity(state.filtered);

  groups.forEach((records) => {
    const base = getMarkerBaseRecord(records);
    const active = records.some((rec) => rec.id === state.selectedId);
    const markerLat = Number(base.lat);
    const markerLng = Number(base.lng);
    const marker = L.marker([markerLat, markerLng], {
      icon: markerIcon(records, active, base),
      keyboard: false,
    });

    marker.bindTooltip(markerTooltip(records), { sticky: true, direction: "top" });
    marker.on("click", () => {
      const next = nextMarkerRecord(records);
      // Only fly on first click (selecting this group); cycling within it stays put
      const alreadyHere = records.some((r) => r.id === state.selectedId);
      selectRecord(next.id, !alreadyHere);
    });
    marker.addTo(layerGroup);

    state.markerGroups.push({ marker, records });
    records.forEach((rec) => {
      state.markers.set(rec.id, marker);
      const lat = Number(rec.lat);
      const lng = Number(rec.lng);
      if (Number.isFinite(lat) && Number.isFinite(lng)) bounds.push([lat, lng]);
    });
  });

  if (fitView && bounds.length) {
    try {
      if (bounds.length === 1) {
        map.setView(bounds[0], 16, { animate: true });
        return;
      }

      const lb = L.latLngBounds(bounds.map(([lat, lng]) => L.latLng(lat, lng)));
      if (!lb.isValid()) return;

      const diagKm = map.distance(lb.getSouthWest(), lb.getNorthEast()) / 1000;
      const maxZoom = diagKm < 5 ? 16 : diagKm < 50 ? 14 : diagKm < 300 ? 11 : 8;
      map.fitBounds(lb, { padding: [42, 42], maxZoom });
    } catch (err) {
      console.error("Failed to fit map to filtered results", err, bounds);
    }
  }
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
  if (el.dossierScroll) el.dossierScroll.scrollTop = 0;

  if (!rec) {
    el.featureCard.innerHTML = `
      <div class="record-empty">
        <span class="record-empty-glyph">&#9670;</span>
        <p>Select a memorial to examine its archival record.</p>
      </div>`;
    return;
  }

  const recordId = safeRecordId(rec.id);
  if (recordId == null) {
    el.featureCard.innerHTML = `
      <div class="record-empty">
        <span class="record-empty-glyph">&#9888;</span>
        <p>This record has an invalid identifier and cannot be displayed safely.</p>
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
      <span class="record-eyebrow">Source Item &middot; #${recordId}</span>
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
        <span class="record-id">ID&middot;${recordId}</span>
      </div>
    </div>`;

  // Adapt image container height/framing to the photo's natural aspect ratio
  const imgWrap = el.featureCard.querySelector(".record-img-wrap");
  const imgEl = imgWrap?.querySelector(".record-img");
  if (imgWrap && imgEl) {
    const syncAspect = () => {
      if (!imgEl.naturalWidth || !imgEl.naturalHeight) return;
      const ratio = imgEl.naturalWidth / imgEl.naturalHeight;
      imgWrap.dataset.aspect =
        ratio < 0.85 ? "portrait" : ratio > 1.15 ? "landscape" : "square";
    };
    if (imgEl.complete && imgEl.naturalWidth > 0) {
      syncAspect();
    } else {
      imgEl.addEventListener("load", syncAspect, { once: true });
      imgEl.addEventListener("error", () => imgWrap.classList.add("is-error"), { once: true });
    }
  }

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

// Full re-render — called only when the filtered data set changes
function renderResults() {
  // Only show count when actively filtering (redundant with topbar otherwise)
  const isFiltered = state.filtered.length !== state.records.length;
  el.resultsNote.textContent = isFiltered ? `${state.filtered.length} results` : "";

  el.resultsList.innerHTML = state.filtered.map((r, i) => {
    const recordId = safeRecordId(r.id);
    if (recordId == null) return "";
    const a    = r.id === state.selectedId ? " is-active" : "";
    const tags = [r.type, r.spatial].filter(Boolean).slice(0, 2);
    const n    = String(i + 1).padStart(3, "0");
    return `
      <article class="ledger-entry${a}" data-id="${recordId}" data-idx="${n}">
        <h3 class="entry-title">${esc(r.title)}</h3>
        <p class="entry-loc">${esc(r.label || r.place || r.spatial || "—")}</p>
        <div class="entry-tags">${tags.map((t) => `<span class="entry-tag">${esc(t)}</span>`).join("")}</div>
      </article>`;
  }).join("");

  el.resultsList.querySelectorAll(".ledger-entry").forEach((c) =>
    c.addEventListener("click", () => selectRecord(Number(c.dataset.id), true)),
  );
}

// Lightweight highlight update — toggles classes without rebuilding DOM
function updateResultsHighlight() {
  el.resultsList.querySelectorAll(".ledger-entry").forEach((c) => {
    c.classList.toggle("is-active", Number(c.dataset.id) === state.selectedId);
  });
}

/* ═══════════════════════════════════════════════════════
   SELECTION + FILTERING
   ═══════════════════════════════════════════════════════ */

function smartFlyTo(rec) {
  const target = L.latLng(rec.lat, rec.lng);
  const targetZoom = getSelectionZoom(rec);
  const currentZoom = map.getZoom();
  const inView = map.getBounds().contains(target);

  // Already zoomed in and point is visible — gentle pan to center it
  if (inView && currentZoom >= targetZoom - 1) {
    map.panTo(target, { animate: true, duration: 0.25 });
    return;
  }

  // Nearby: moderate fly
  const dist = map.distance(map.getCenter(), target);
  if (dist < 8000 && currentZoom >= targetZoom - 3) {
    map.flyTo(target, Math.max(currentZoom, targetZoom), { duration: 0.4 });
    return;
  }

  // Distant — full fly
  map.flyTo(target, targetZoom, { duration: 0.6 });
}

function selectRecord(id, pan = false) {
  const normalizedId = id == null ? null : safeRecordId(id);
  const prevId = state.selectedId;
  const rec =
    normalizedId == null
      ? null
      : state.filtered.find((r) => r.id === normalizedId) || state.records.find((r) => r.id === normalizedId);
  state.selectedId = rec?.id ?? null;
  renderFeature(rec ?? null);
  updateResultsHighlight();
  updateMarkerStyles(prevId);
  if (rec) {
    const wasCollapsed = el.ledger.classList.contains("is-collapsed");
    el.dossier.classList.remove("is-hidden");
    el.ledger.classList.remove("is-collapsed");
    if (wasCollapsed) {
      setTimeout(scrollToActive, 260);
    } else {
      scrollToActive();
    }
  } else {
    el.dossier.classList.add("is-hidden");
  }
  if (pan && rec) {
    smartFlyTo(rec);
  }
}

function applyFilters() {
  const q = el.searchInput.value.trim().toLowerCase();
  const t = el.typeFilter.value;
  const fitView = Boolean(q) || t !== "all";
  state.filtered = state.records.filter((r) => {
    const hay = buildHaystack(r);
    return (!q || hay.includes(q)) && (t === "all" || (r.types?.length ? r.types.includes(t) : r.type === t));
  });

  // Sort so proximity-grouped items appear adjacent in the ledger
  const groups = groupRecordsByProximity(state.filtered);
  groups.sort((a, b) => (a[0].spatial || "").localeCompare(b[0].spatial || ""));
  state.filtered = groups.flat();

  rebuildMarkers(groups, fitView);
  renderResults();
  if (!state.filtered.some((r) => r.id === state.selectedId))
    selectRecord(null, false);
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
    const recordId = safeRecordId(r.id);
    if (recordId == null) return "";
    const siteLabel = r.label || r.place || r.spatial || null;
    const showRecordTitle = siteLabel && siteLabel !== r.title;
    const thumb = r.image
      ? `<img class="cat-thumb" src="${esc(r.image)}" alt="" loading="lazy" />`
      : `<div class="cat-placeholder"><div class="cat-ph-dot" style="background:${typeColor(r.type)}"></div></div>`;
    return `
      <div class="cat-card" data-id="${recordId}" tabindex="0">
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
      // Clear any active filters so the selected record is visible on the map
      el.searchInput.value = "";
      el.typeFilter.value = "all";
      applyFilters();
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
    state.records.filter((r) => buildHaystack(r).includes(q)),
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

// Keys use the full "Name; City, State" format from the API's dcterms:spatial field
const INSTITUTION_URLS = {
  "College of William and Mary; Williamsburg, Virginia": "https://locatinglegacies.org/s/william-and-mary/page/home",
  "Davidson College; Davidson, North Carolina": "https://locatinglegacies.org/s/davidson/page/welcome",
  "Elon University; Elon, North Carolina": "https://locatinglegacies.org/s/elon/page/home",
  "Emory University; Atlanta, Georgia": "https://locatinglegacies.org/s/emory/page/welcome",
  "Furman University; Greenville, South Carolina": "https://locatinglegacies.org/s/furman/page/home",
  "Hampden-Sydney College; Hampden Sydney, Virginia": "https://locatinglegacies.org/s/hampden-sydney/page/welcome",
  "Hendrix College; Conway, Arkansas": "https://locatinglegacies.org/s/hendrix/page/welcome",
  "Loyola University Maryland; Baltimore, Maryland": "https://locatinglegacies.org/s/loyola-maryland/page/welcome",
  "Meredith College; Raleigh, North Carolina": "https://locatinglegacies.org/s/meredith/page/home",
  "Rhodes College; Memphis, Tennessee": "https://locatinglegacies.org/s/rhodes/page/welcome",
  "Rollins College; Winter Park, Florida": "https://locatinglegacies.org/s/rollins/page/home",
  "University of Alabama; Tuscaloosa, Alabama": "https://locatinglegacies.org/s/UA/page/welcome",
  "University of Georgia; Athens, Georgia": "https://locatinglegacies.org/s/UGA/page/welcome",
  "University of South Carolina; Columbia, South Carolina": "https://locatinglegacies.org/s/USC/page/welcome",
  "University of the South; Sewanee, Tennessee": "https://locatinglegacies.org/s/Sewanee/page/home",
  "University of Virginia; Charlottesville, Virginia": "https://locatinglegacies.org/s/UVA/page/welcome",
  "Virginia Military Institute; Lexington, Virginia": "https://locatinglegacies.org/s/VMI/page/home",
  "Western Kentucky University; Bowling Green, Kentucky": "https://locatinglegacies.org/s/WKU/page/welcome",
  "Wofford College; Spartanburg, South Carolina": "https://locatinglegacies.org/s/wofford/page/home",
};

function institutionUrl(name) {
  // Try exact match first (fastest path)
  if (INSTITUTION_URLS[name]) return INSTITUTION_URLS[name];
  // Fallback: match by institution name before the semicolon
  const shortName = name.split(";")[0].trim().toLowerCase();
  for (const [key, url] of Object.entries(INSTITUTION_URLS)) {
    if (key.split(";")[0].trim().toLowerCase() === shortName) return url;
  }
  return "https://locatinglegacies.org/s/hub/page/partners";
}

function openInstitutions() {
  const counts = new Map();
  for (const r of state.records) if (r.spatial) counts.set(r.spatial, (counts.get(r.spatial) || 0) + 1);
  const all = [...counts.entries()].sort((a, b) => b[1] - a[1]);

  function render(list) {
    el.instList.innerHTML = list.map(([name, count]) => {
      const url = institutionUrl(name);
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
    const res = await fetch("/api/config");
    if (res.ok) {
      const data = await res.json();
      if (typeof data?.cartoApiKey === "string") {
        cartoApiKey = data.cartoApiKey.trim();
      }
    }
  } catch (err) {
    console.error("Failed to load map config:", err);
  } finally {
    configReady = true;
    mountBaseLayer(document.body.dataset.theme || resolveInitialTheme());
  }
})();

el.ledger?.addEventListener("transitionend", (e) => {
  if (e.propertyName === "width") map.invalidateSize({ animate: false, pan: false });
});

el.dossier?.addEventListener("transitionend", (e) => {
  if (e.propertyName === "width") map.invalidateSize({ animate: false, pan: false });
});

/* ── Ledger toggle ───────────────────────────────────── */
el.ledgerToggle?.addEventListener("click", () => {
  el.ledger.classList.toggle("is-collapsed");
});

/* ── Dossier close ───────────────────────────────────── */
el.dossierClose?.addEventListener("click", () => {
  selectRecord(null, false);
});

(async () => {
  try {
    const res = await fetch("/api/legacies");
    if (!res.ok) throw new Error("Failed");
    const { meta, records } = await res.json();
    state.records = records;

    const types = [...new Set(records.flatMap((r) => r.types?.length ? r.types : (r.type ? [r.type] : [])))].sort();
    el.typeFilter.innerHTML =
      `<option value="all">All types</option>` +
      types.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join("");

    el.mappedCount.textContent = String(meta.mappedItems);
    el.institutionCount.textContent = String(meta.institutions);
    el.fetchedAt.textContent =
      meta.source === "archive"
        ? `Archive · ${fmtDate(meta.archiveDate || meta.fetchedAt)}`
        : `Live · ${fmtDate(meta.fetchedAt)}`;

    applyFilters();
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
