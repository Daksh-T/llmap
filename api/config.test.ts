import { afterEach, describe, expect, it } from "bun:test";
import handler from "./config";

const originalUpper = process.env.CARTO_API_KEY;
const originalLower = process.env.carto_api_key;

describe("/api/config", () => {
  afterEach(() => {
    if (originalUpper === undefined) delete process.env.CARTO_API_KEY;
    else process.env.CARTO_API_KEY = originalUpper;

    if (originalLower === undefined) delete process.env.carto_api_key;
    else process.env.carto_api_key = originalLower;
  });

  it("returns CARTO_API_KEY when set", async () => {
    process.env.CARTO_API_KEY = "cb1_test_upper";
    process.env.carto_api_key = "cb1_test_lower";

    const response = await handler.fetch();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ cartoApiKey: "cb1_test_upper" });
  });

  it("falls back to lowercase carto_api_key when CARTO_API_KEY is unset", async () => {
    delete process.env.CARTO_API_KEY;
    process.env.carto_api_key = "cb1_test_lower";

    const response = await handler.fetch();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ cartoApiKey: "cb1_test_lower" });
  });

  it("returns an empty string when neither env var is set", async () => {
    delete process.env.CARTO_API_KEY;
    delete process.env.carto_api_key;

    const response = await handler.fetch();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ cartoApiKey: "" });
  });
});
