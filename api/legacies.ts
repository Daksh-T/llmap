const API_ROOT = "https://locatinglegacies.org/api/items";
const SITE_ITEM_URL = "https://locatinglegacies.org/s/hub/item";
const CACHE_TTL_SECONDS = 60 * 15;

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

function trimDescription(text: string | null, limit = 220): string | null {
  if (!text) return null;
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit).trimEnd()}...`;
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
  });

  if (!response.ok) {
    throw new Error(`Upstream API error: ${response.status}`);
  }

  return response;
}

async function fetchLegaciesData() {
  const perPage = 100;
  const records: any[] = [];

  const firstResponse = await fetchPage(1, perPage);
  const totalResults = Number(firstResponse.headers.get("omeka-s-total-results") ?? "0");
  const firstPageItems = (await firstResponse.json()) as any[];
  records.push(...firstPageItems);

  const totalPages = Math.ceil(totalResults / perPage);

  if (totalPages > 1) {
    const remainingResponses = await Promise.all(
      Array.from({ length: totalPages - 1 }, (_, index) => fetchPage(index + 2, perPage)),
    );

    const remainingPages = await Promise.all(
      remainingResponses.map((response) => response.json() as Promise<any[]>),
    );

    for (const pageItems of remainingPages) {
      records.push(...pageItems);
    }
  }

  const normalized = records
    .map((item) => {
      const marker = item["o-module-mapping:marker"]?.[0];
      const lat = Number(marker?.["o-module-mapping:lat"]);
      const lng = Number(marker?.["o-module-mapping:lng"]);

      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return null;
      }

      const title = item["o:title"] ?? "Untitled memorial";
      const description = trimDescription(getDisplayValue(item["dcterms:description"]));
      const type = getDisplayValue(item["dcterms:type"]);
      const scope = getDisplayValue(item["dcterms:extent"]);
      const temporal = getDisplayValue(item["dcterms:temporal"]);
      const spatial = getDisplayValue(item["dcterms:spatial"]);
      const place = getDisplayValue(item["bio:place"]);
      const people = getDisplayValues(item["bio:agent"]);
      const label = marker?.["o-module-mapping:label"] ?? place ?? spatial ?? null;

      return {
        id: item["o:id"],
        title,
        description,
        lat,
        lng,
        type,
        scope,
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
        itemUrl: `${SITE_ITEM_URL}/${item["o:id"]}`,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

  const institutions = new Set(
    normalized.map((item) => item.spatial).filter((value): value is string => Boolean(value)),
  );

  const types = new Map<string, number>();
  for (const item of normalized) {
    const key = item.type ?? "Unclassified";
    types.set(key, (types.get(key) ?? 0) + 1);
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

export default {
  async fetch() {
    try {
      const payload = await fetchLegaciesData();

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
