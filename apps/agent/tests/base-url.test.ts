/**
 * Unit tests for the public-origin resolver.
 */
import { describe, it, expect } from "vitest";
import { resolveBaseUrl, withBaseUrl, APP_BASE_URL_HEADER } from "../src/base-url.js";

describe("resolveBaseUrl", () => {
  it("prefers APP_BASE_URL when set", () => {
    const req = new Request("https://x/", { headers: { [APP_BASE_URL_HEADER]: "https://header.example" } });
    expect(resolveBaseUrl({ APP_BASE_URL: "https://env.example" }, req)).toBe("https://env.example");
  });

  it("falls back to the x-app-base-url header", () => {
    const req = new Request("https://x/", { headers: { [APP_BASE_URL_HEADER]: "https://header.example/" } });
    expect(resolveBaseUrl({}, req)).toBe("https://header.example");
  });

  it("returns empty string when neither is available", () => {
    expect(resolveBaseUrl({})).toBe("");
  });

  it("strips a trailing slash from env values", () => {
    expect(resolveBaseUrl({ APP_BASE_URL: "https://example.test/" })).toBe("https://example.test");
  });
});

describe("withBaseUrl", () => {
  it("strips incoming spoofed headers before stamping", () => {
    const req = new Request("https://x/", { headers: { [APP_BASE_URL_HEADER]: "https://attacker" } });
    const out = withBaseUrl(req, "https://real");
    expect(out.headers.get(APP_BASE_URL_HEADER)).toBe("https://real");
  });

  it("drops the header when baseUrl is empty", () => {
    const req = new Request("https://x/", { headers: { [APP_BASE_URL_HEADER]: "https://attacker" } });
    const out = withBaseUrl(req, "");
    expect(out.headers.get(APP_BASE_URL_HEADER)).toBeNull();
  });
});
