const API_ROOT = "https://locatinglegacies.org/api/items";
const SITE_ITEM_URL = "https://locatinglegacies.org/s/hub/item";
const CACHE_TTL_SECONDS = 60 * 15;
const CACHE_TTL_MS = CACHE_TTL_SECONDS * 1000;
const MAX_PAGES = 100;
const PAGE_BATCH_SIZE = 5;
const UPSTREAM_TIMEOUT_MS = 10_000;

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

function buildUrl(page: number, perPage: number) {
  const url = new URL(API_ROOT);
  url.searchParams.set("site_id", "7");
  url.searchParams.set("resource_template_id[]", "2");
  url.searchParams.set("per_page", String(perPage));
  url.searchParams.set("page", String(page));
  return url;
}

async function fetchPage(page: number, perPage: number) {
  const response = await fetch(buildUrl(page, perPage), {
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

function normalizeRecord(item: UpstreamItem): LegaciesRecord | null {
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
    itemUrl: `${SITE_ITEM_URL}/${id}`,
  };
}

async function fetchLegaciesData() {
  const perPage = 100;
  const records: UpstreamItem[] = [];

  const firstPage = await fetchPage(1, perPage);
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
        Array.from({ length: batchEnd - page + 1 }, (_, index) => fetchPage(page + index, perPage)),
      );

      for (const result of batch) {
        records.push(...result.items);
      }
    }
  }

  const normalized = records
    .map(normalizeRecord)
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

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
      fetchedAt: new Date().toISOString(),
      totalItems: totalResults,
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
