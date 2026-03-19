const map = L.map("map", {
  zoomControl: false,
  minZoom: 4,
}).setView([37.8, -96], 4);

L.control.zoom({ position: "topright" }).addTo(map);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

const state = {
  records: [],
  filtered: [],
  selectedId: null,
  markers: new Map(),
};

const elements = {
  mappedCount: document.getElementById("mapped-count"),
  institutionCount: document.getElementById("institution-count"),
  fetchedAt: document.getElementById("fetched-at"),
  featureCard: document.getElementById("feature-card"),
  typePills: document.getElementById("type-pills"),
  resultsList: document.getElementById("results-list"),
  resultsNote: document.getElementById("results-note"),
  searchInput: document.getElementById("search-input"),
  typeFilter: document.getElementById("type-filter"),
};

const layerGroup = L.layerGroup().addTo(map);

function formatDate(value) {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function markerIcon(active = false) {
  return L.divIcon({
    className: "",
    html: `<div class="atlas-marker${active ? " active" : ""}"></div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
    popupAnchor: [0, -8],
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderTypePills(topTypes) {
  elements.typePills.innerHTML = topTypes
    .map(
      (type) => `
        <div class="type-pill">
          <strong>${type.count}</strong>
          <span>${escapeHtml(type.label)}</span>
        </div>
      `,
    )
    .join("");
}

function renderFeature(record) {
  if (!record) {
    elements.featureCard.innerHTML =
      '<p class="empty-state">Choose a marker or list entry to inspect a memorial.</p>';
    return;
  }

  const people = record.people?.length
    ? `<div><strong>Memorialized:</strong> ${escapeHtml(record.people.join(", "))}</div>`
    : "";
  const place = record.place || record.label || record.spatial || "Location not labeled";
  const type = record.type ? `<div><strong>Type:</strong> ${escapeHtml(record.type)}</div>` : "";
  const temporal = record.temporal
    ? `<div><strong>Historical frame:</strong> ${escapeHtml(record.temporal)}</div>`
    : "";
  const scope = record.scope ? `<div><strong>Extent:</strong> ${escapeHtml(record.scope)}</div>` : "";
  const image = record.image
    ? `<img src="${escapeHtml(record.image)}" alt="${escapeHtml(record.title)}" />`
    : "";

  elements.featureCard.innerHTML = `
    ${image}
    <div>
      <h2 class="feature-title">${escapeHtml(record.title)}</h2>
      <p class="feature-description">${escapeHtml(
        record.description || "No public description was provided in the source record.",
      )}</p>
    </div>
    <div class="feature-meta">
      <div><strong>Mapped location:</strong> ${escapeHtml(place)}</div>
      ${type}
      ${scope}
      ${temporal}
      ${people}
      ${
        record.spatial
          ? `<div><strong>Institution:</strong> ${escapeHtml(record.spatial)}</div>`
          : ""
      }
    </div>
    <div class="feature-actions">
      <a class="feature-link primary" href="${escapeHtml(record.itemUrl)}" target="_blank" rel="noreferrer">
        Open source record
      </a>
      <span class="feature-link">ID ${record.id}</span>
    </div>
  `;
}

function updateMarkerStyles() {
  state.markers.forEach((marker, id) => {
    marker.setIcon(markerIcon(id === state.selectedId));
  });
}

function selectRecord(id, shouldPan = false) {
  const record = state.filtered.find((entry) => entry.id === id) || state.records.find((entry) => entry.id === id);
  state.selectedId = record?.id ?? null;
  renderFeature(record ?? null);
  renderResults();
  updateMarkerStyles();

  if (shouldPan && record) {
    map.flyTo([record.lat, record.lng], Math.max(map.getZoom(), 8), {
      duration: 0.65,
    });
  }
}

function renderResults() {
  elements.resultsNote.textContent = `${state.filtered.length} entries`;

  elements.resultsList.innerHTML = state.filtered
    .slice(0, 80)
    .map((record) => {
      const active = record.id === state.selectedId ? " active" : "";
      const tags = [record.type, record.spatial].filter(Boolean).slice(0, 2);

      return `
        <article class="result-card${active}" data-id="${record.id}">
          <h3 class="result-title">${escapeHtml(record.title)}</h3>
          <p class="result-meta">${escapeHtml(
            record.label || record.place || record.spatial || "Mapped location available",
          )}</p>
          <div class="result-tags">
            ${tags
              .map((tag) => `<span class="result-tag">${escapeHtml(tag)}</span>`)
              .join("")}
          </div>
        </article>
      `;
    })
    .join("");

  elements.resultsList.querySelectorAll(".result-card").forEach((card) => {
    card.addEventListener("click", () => {
      selectRecord(Number(card.dataset.id), true);
    });
  });
}

function rebuildMarkers() {
  layerGroup.clearLayers();
  state.markers.clear();

  const bounds = [];

  state.filtered.forEach((record) => {
    const marker = L.marker([record.lat, record.lng], {
      icon: markerIcon(record.id === state.selectedId),
      title: record.title,
    });

    marker.bindPopup(
      `<strong>${escapeHtml(record.title)}</strong><br>${escapeHtml(
        record.label || record.spatial || "Mapped memorial",
      )}`,
    );
    marker.on("click", () => {
      selectRecord(record.id, false);
    });

    marker.addTo(layerGroup);
    state.markers.set(record.id, marker);
    bounds.push([record.lat, record.lng]);
  });

  if (bounds.length) {
    map.fitBounds(bounds, { padding: [42, 42] });
  }
}

function applyFilters() {
  const query = elements.searchInput.value.trim().toLowerCase();
  const selectedType = elements.typeFilter.value;

  state.filtered = state.records.filter((record) => {
    const haystack = [
      record.title,
      record.description,
      record.place,
      record.label,
      record.spatial,
      record.type,
      ...(record.people || []),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    const matchesQuery = !query || haystack.includes(query);
    const matchesType = selectedType === "all" || record.type === selectedType;
    return matchesQuery && matchesType;
  });

  rebuildMarkers();
  renderResults();

  if (!state.filtered.some((record) => record.id === state.selectedId)) {
    selectRecord(state.filtered[0]?.id ?? null, false);
  } else {
    updateMarkerStyles();
  }
}

async function loadData() {
  const response = await fetch("/api/legacies");
  if (!response.ok) {
    throw new Error("Failed to load map data.");
  }

  const payload = await response.json();
  const { meta, records } = payload;

  state.records = records;
  state.filtered = records;

  const uniqueTypes = [...new Set(records.map((record) => record.type).filter(Boolean))].sort();
  elements.typeFilter.innerHTML = `
    <option value="all">All memorial types</option>
    ${uniqueTypes
      .map((type) => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`)
      .join("")}
  `;

  elements.mappedCount.textContent = String(meta.mappedItems);
  elements.institutionCount.textContent = String(meta.institutions);
  elements.fetchedAt.textContent = `Live pull refreshed ${formatDate(meta.fetchedAt)}`;
  renderTypePills(meta.topTypes);

  applyFilters();
  selectRecord(state.filtered[0]?.id ?? null, false);
}

elements.searchInput.addEventListener("input", applyFilters);
elements.typeFilter.addEventListener("change", applyFilters);

loadData().catch((error) => {
  console.error(error);
  elements.featureCard.innerHTML =
    '<p class="empty-state">The live data fetch failed. Check the Bun server logs and try again.</p>';
  elements.fetchedAt.textContent = "Live fetch unavailable";
});
