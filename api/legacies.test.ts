import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import handler, { __resetCacheForTests } from "./legacies";

const originalFetch = globalThis.fetch;

function buildUpstreamItem(id: unknown) {
  return {
    "o:id": id,
    "o:title": "Memorial",
    "o-module-mapping:marker": [
      {
        "o-module-mapping:lat": "35.1",
        "o-module-mapping:lng": "-89.9",
        "o-module-mapping:label": "Test label",
      },
    ],
    "dcterms:description": [{ "@value": "Description" }],
    "dcterms:type": [{ "@value": "Marker" }],
    "dcterms:spatial": [{ "@value": "Test University; Test City, Tennessee" }],
    thumbnail_display_urls: {
      square: "https://example.com/thumb.jpg",
    },
  };
}

function jsonResponse(body: unknown, totalResults: number) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "omeka-s-total-results": String(totalResults),
    },
  });
}

describe("/api/legacies", () => {
  beforeEach(() => {
    __resetCacheForTests();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    __resetCacheForTests();
  });

  it("rejects unsupported query parameters before hitting the upstream API", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return jsonResponse([], 0);
    }) as typeof fetch;

    const response = await handler.fetch(new Request("https://example.com/api/legacies?cachebust=1"));

    expect(response.status).toBe(400);
    expect(fetchCalls).toBe(0);
    await expect(response.json()).resolves.toEqual({
      error: "Query parameters are not supported on this endpoint.",
    });
  });

  it("drops records with invalid upstream IDs while preserving valid records", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(
        [
          buildUpstreamItem(42),
          buildUpstreamItem('"><img src=x onerror=alert(1)>'),
        ],
        2,
      )) as typeof fetch;

    const response = await handler.fetch(new Request("https://example.com/api/legacies"));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.records).toHaveLength(1);
    expect(payload.records[0].id).toBe(42);
    expect(payload.records[0].itemUrl).toBe("https://locatinglegacies.org/s/hub/item/42");
  });

  it("dedupes concurrent fetches and serves warm responses from memory cache", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return jsonResponse([buildUpstreamItem(7)], 1);
    }) as typeof fetch;

    const request = new Request("https://example.com/api/legacies");
    const [first, second] = await Promise.all([handler.fetch(request), handler.fetch(request)]);
    const third = await handler.fetch(request);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(200);
    expect(fetchCalls).toBe(1);
  });
});
