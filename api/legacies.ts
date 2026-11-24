const LIVE_SOURCES = [
  {
    apiRoot: "https://locatinglegacies.org/api/items",
    siteItemUrl: "https://locatinglegacies.org/s/hub/item",
  },
  {
    apiRoot: "https://locatinglegacies.org/index.php/api/items",
    siteItemUrl: "https://locatinglegacies.org/index.php/s/hub/item",
  },
] as const;
const SITE_ITEM_URL = LIVE_SOURCES[0].siteItemUrl;
const WAYBACK_TIMESTAMP = "20260411001947";
const WAYBACK_ARCHIVE_DATE = "2026-04-11T00:19:47Z";
const WAYBACK_MAP_URL = `https://web.archive.org/web/${WAYBACK_TIMESTAMP}id_/https://locatinglegacies.org/s/hub/page/map`;
const WAYBACK_ITEM_PREFIX = `https://web.archive.org/web/${WAYBACK_TIMESTAMP}/${SITE_ITEM_URL}`;
const CACHE_TTL_SECONDS = 60 * 15;
const CACHE_TTL_MS = CACHE_TTL_SECONDS * 1000;
const MAX_PAGES = 100;
const PAGE_BATCH_SIZE = 5;
const UPSTREAM_TIMEOUT_MS = 10_000;
const WAYBACK_TIMEOUT_MS = 15_000;

type UpstreamItem = Record<string, any>;

type LegaciesRecord = {
  id: number;
  title: string;
  description: string | null;
  lat: number;
  lng: number;
  classification: string | null;
  types: string[];
  type: string | null;
  contexts: string[];
  scope: string | null;
  periods: string[];
  temporal: string | null;
  spatial: string | null;
  place: string | null;
  label: string | null;
  people: string[];
  image: string | null;
  itemUrl: string;
};

type LegaciesPayload = {
  meta: {
    source: "live" | "archive";
    archiveDate?: string;
    archiveUrl?: string;
    fetchedAt: string;
    totalItems: number;
    mappedItems: number;
    institutions: number;
    topTypes: Array<{ label: string; count: number }>;
  };
  records: LegaciesRecord[];
};

let cachedPayload: LegaciesPayload | null = null;
let cacheExpiresAt = 0;
let inFlightPayload: Promise<LegaciesPayload> | null = null;

function getDisplayValue(values?: any[]): string | null {
  if (!values?.length) return null;

  for (const value of values) {
    if (typeof value?.display_title === "string" && value.display_title.trim()) {
      return value.display_title.trim();
    }

    if (typeof value?.["@value"] === "string" && value["@value"].trim()) {
      return value["@value"].trim();
    }

    if (typeof value?.["o:label"] === "string" && value["o:label"].trim()) {
      return value["o:label"].trim();
    }
  }

  return null;
}

function getDisplayValues(values?: any[]): string[] {
  if (!values?.length) return [];
  return values
    .map((entry) => getDisplayValue([entry]))
    .filter((value): value is string => Boolean(value));
}

function normalizeText(text: string | null): string | null {
  if (!text) return null;
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized || null;
}

function parseRecordId(value: unknown): number | null {
  const id =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;

  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function buildUrl(apiRoot: string, page: number, perPage: number) {
  const url = new URL(apiRoot);
  url.searchParams.set("site_id", "7");
  url.searchParams.set("resource_template_id[]", "2");
  url.searchParams.set("per_page", String(perPage));
  url.searchParams.set("page", String(page));
  return url;
}

async function fetchPage(apiRoot: string, page: number, perPage: number) {
  const response = await fetch(buildUrl(apiRoot, page, perPage), {
    headers: {
      Accept: "application/ld+json",
    },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Upstream API error: ${response.status}`);
  }

  const items = (await response.json()) as UpstreamItem[];
  const totalResults = Number(response.headers.get("omeka-s-total-results") ?? "0");

  return { items, totalResults };
}

function normalizeRecord(item: UpstreamItem, siteItemUrl = SITE_ITEM_URL): LegaciesRecord | null {
  const id = parseRecordId(item["o:id"]);
  if (id == null) return null;

  const marker = item["o-module-mapping:marker"]?.[0];
  const lat = Number(marker?.["o-module-mapping:lat"]);
  const lng = Number(marker?.["o-module-mapping:lng"]);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }

  const title = item["o:title"] ?? "Untitled memorial";
  const description = normalizeText(getDisplayValue(item["dcterms:description"]));
  const classification = getDisplayValue(item["dcterms:identifier"]);
  const types = getDisplayValues(item["dcterms:type"]);
  const contexts = getDisplayValues(item["dcterms:extent"]);
  const periods = getDisplayValues(item["dcterms:temporal"]);
  const type = types[0] ?? null;
  const scope = contexts[0] ?? null;
  const temporal = periods[0] ?? null;
  const spatial = getDisplayValue(item["dcterms:spatial"]);
  const place = getDisplayValue(item["bio:place"]);
  const people = getDisplayValues(item["bio:agent"]);
  const label = marker?.["o-module-mapping:label"] ?? place ?? spatial ?? null;

  return {
    id,
    title,
    description,
    lat,
    lng,
    classification,
    types,
    type,
    contexts,
    scope,
    periods,
    temporal,
    spatial,
    place,
    label,
    people,
    image:
      item["thumbnail_display_urls"]?.large ??
      item["thumbnail_display_urls"]?.medium ??
      item["thumbnail_display_urls"]?.square ??
      null,
    itemUrl: `${siteItemUrl}/${id}`,
  };
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&");
}

function buildPayload(
  normalized: LegaciesRecord[],
  totalItems: number,
  extraMeta: { source: "live" | "archive"; archiveDate?: string; archiveUrl?: string },
): LegaciesPayload {
  const institutions = new Set(
    normalized.map((item) => item.spatial).filter((value): value is string => Boolean(value)),
  );

  const types = new Map<string, number>();
  for (const item of normalized) {
    const labels = item.types?.length ? item.types : [item.type ?? "Unclassified"];
    for (const label of labels) {
      types.set(label, (types.get(label) ?? 0) + 1);
    }
  }

  return {
    meta: {
      ...extraMeta,
      fetchedAt: new Date().toISOString(),
      totalItems,
      mappedItems: normalized.length,
      institutions: institutions.size,
      topTypes: [...types.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([label, count]) => ({ label, count })),
    },
    records: normalized,
  };
}

function parseWaybackMapHtml(html: string): LegaciesRecord[] {
  const markersMatch = html.match(/data-markers="([^"]+)"/);
  if (!markersMatch) {
    throw new Error("Wayback map snapshot missing data-markers payload");
  }

  const rawMarkers = JSON.parse(decodeHtmlEntities(markersMatch[1])) as UpstreamItem[];
  if (!Array.isArray(rawMarkers)) {
    throw new Error("Wayback map snapshot has invalid data-markers payload");
  }

  type PopupInfo = {
    title: string | null;
    image: string | null;
    heading: string | null;
  };

  const popupsByMarkerId = new Map<number, PopupInfo>();
  const popupsByItemId = new Map<number, PopupInfo>();

  const popupRegex =
    /<div class="mapping-marker-popup-content"[^>]*data-marker-id="(\d+)"[^>]*data-item-id="(\d+)"[^>]*>([\s\S]*?)<\/div>\s*(?=<div class="mapping-marker-popup-content"|<\/div>)/g;

  for (const match of html.matchAll(popupRegex)) {
    const markerId = parseRecordId(match[1]);
    const itemId = parseRecordId(match[2]);
    const body = match[3] ?? "";

    const titleMatch = body.match(/Item:\s*<a[^>]*>([\s\S]*?)<\/a>/);
    const imgMatch = body.match(/<img\s+[^>]*src="([^"]+)"/);
    const headingMatch = body.match(/<h3[^>]*>([\s\S]*?)<\/h3>/);

    const info: PopupInfo = {
      title: titleMatch ? normalizeText(decodeHtmlEntities(titleMatch[1])) : null,
      image: imgMatch ? decodeHtmlEntities(imgMatch[1]).trim() || null : null,
      heading: headingMatch ? normalizeText(decodeHtmlEntities(headingMatch[1])) : null,
    };

    if (markerId != null) popupsByMarkerId.set(markerId, info);
    if (itemId != null && !popupsByItemId.has(itemId)) popupsByItemId.set(itemId, info);
  }

  const recordsByItemId = new Map<number, LegaciesRecord>();

  for (const marker of rawMarkers) {
    const itemId = parseRecordId(marker?.["o:item"]?.["o:id"]);
    if (itemId == null) continue;

    const lat = Number(marker?.["o-module-mapping:lat"]);
    const lng = Number(marker?.["o-module-mapping:lng"]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const markerId = parseRecordId(marker?.["o:id"]);
    const popup =
      (markerId != null ? popupsByMarkerId.get(markerId) : undefined) ??
      popupsByItemId.get(itemId);

    const label = normalizeText(
      typeof marker?.["o-module-mapping:label"] === "string"
        ? marker["o-module-mapping:label"]
        : popup?.heading ?? null,
    );
    const image = popup?.image ?? null;
    const title = popup?.title ?? "Untitled memorial";

    const existing = recordsByItemId.get(itemId);
    if (existing) {
      if (!existing.image && image) existing.image = image;
      if (!existing.label && label) existing.label = label;
      continue;
    }

    recordsByItemId.set(itemId, {
      id: itemId,
      title,
      description: null,
      lat,
      lng,
      classification: null,
      types: [],
      type: null,
      contexts: [],
      scope: null,
      periods: [],
      temporal: null,
      spatial: null,
      place: null,
      label,
      people: [],
      image,
      itemUrl: `${WAYBACK_ITEM_PREFIX}/${itemId}`,
    });
  }

  return [...recordsByItemId.values()];
}

async function fetchWaybackFallbackData(): Promise<LegaciesPayload> {
  const response = await fetch(WAYBACK_MAP_URL, {
    headers: {
      Accept: "text/html",
    },
    signal: AbortSignal.timeout(WAYBACK_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Wayback fallback error: ${response.status}`);
  }

  const html = await response.text();
  const normalized = parseWaybackMapHtml(html);
  if (normalized.length === 0) {
    throw new Error("Wayback map snapshot contained no valid markers");
  }

  return buildPayload(normalized, normalized.length, {
    source: "archive",
    archiveDate: WAYBACK_ARCHIVE_DATE,
    archiveUrl: `https://web.archive.org/web/${WAYBACK_TIMESTAMP}/https://locatinglegacies.org/s/hub/page/map`,
  });
}

async function fetchLiveLegaciesDataFrom(apiRoot: string, siteItemUrl: string): Promise<LegaciesPayload> {
  const perPage = 100;
  const records: UpstreamItem[] = [];

  const firstPage = await fetchPage(apiRoot, 1, perPage);
  const totalResults = firstPage.totalResults;
  records.push(...firstPage.items);

  const totalPages = Math.ceil(totalResults / perPage);
  if (totalPages > MAX_PAGES) {
    throw new Error(`Upstream page count ${totalPages} exceeds safety limit ${MAX_PAGES}`);
  }

  if (totalPages > 1) {
    for (let page = 2; page <= totalPages; page += PAGE_BATCH_SIZE) {
      const batchEnd = Math.min(totalPages, page + PAGE_BATCH_SIZE - 1);
      const batch = await Promise.all(
        Array.from({ length: batchEnd - page + 1 }, (_, index) =>
          fetchPage(apiRoot, page + index, perPage),
        ),
      );

      for (const result of batch) {
        records.push(...result.items);
      }
    }
  }

  const normalized = records
    .map((item) => normalizeRecord(item, siteItemUrl))
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

  return buildPayload(normalized, totalResults, { source: "live" });
}

async function fetchLegaciesData(): Promise<LegaciesPayload> {
  let lastError: unknown;

  for (const source of LIVE_SOURCES) {
    try {
      return await fetchLiveLegaciesDataFrom(source.apiRoot, source.siteItemUrl);
    } catch (error) {
      lastError = error;
    }
  }

  try {
    return await fetchWaybackFallbackData();
  } catch {
    throw lastError;
  }
}

async function getCachedPayload() {
  const now = Date.now();
  if (cachedPayload && now < cacheExpiresAt) {
    return cachedPayload;
  }

  if (inFlightPayload) {
    return inFlightPayload;
  }

  inFlightPayload = fetchLegaciesData()
    .then((payload) => {
      cachedPayload = payload;
      cacheExpiresAt = Date.now() + CACHE_TTL_MS;
      return payload;
    })
    .finally(() => {
      inFlightPayload = null;
    });

  return inFlightPayload;
}

export function __resetCacheForTests() {
  cachedPayload = null;
  cacheExpiresAt = 0;
  inFlightPayload = null;
}

export default {
  async fetch(req = new Request("http://localhost/api/legacies")) {
    const url = new URL(req.url);
    if ([...url.searchParams.keys()].length > 0) {
      return Response.json(
        { error: "Query parameters are not supported on this endpoint." },
        {
          status: 400,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }

    try {
      const payload = await getCachedPayload();

      return Response.json(payload, {
        headers: {
          "Cache-Control": `public, s-maxage=${CACHE_TTL_SECONDS}, stale-while-revalidate=${CACHE_TTL_SECONDS}`,
        },
      });
    } catch (error) {
      return Response.json(
        {
          error: "Failed to fetch Locating Legacies data.",
          detail: error instanceof Error ? error.message : "Unknown error",
        },
        { status: 502 },
      );
    }
  },
};
