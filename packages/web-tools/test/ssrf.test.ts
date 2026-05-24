import { describe, expect, it } from "vitest";
import { validateFetchUrl } from "../src/ssrf.js";

describe("validateFetchUrl", () => {
  it("accepts public https URLs", () => {
    expect(() => validateFetchUrl("https://example.com/foo")).not.toThrow();
  });

  it("accepts public http URLs", () => {
    expect(() => validateFetchUrl("http://example.com")).not.toThrow();
  });

  it("rejects non-http(s) schemes", () => {
    expect(() => validateFetchUrl("file:///etc/passwd")).toThrow(/scheme/i);
    expect(() => validateFetchUrl("ftp://example.com")).toThrow(/scheme/i);
    expect(() => validateFetchUrl("data:text/plain,hi")).toThrow(/scheme/i);
    expect(() => validateFetchUrl("javascript:alert(1)")).toThrow(/scheme/i);
  });

  it("rejects malformed URLs", () => {
    expect(() => validateFetchUrl("not a url")).toThrow();
  });

  it("rejects localhost and loopback names", () => {
    expect(() => validateFetchUrl("http://localhost/")).toThrow(/private|loopback/i);
    expect(() => validateFetchUrl("http://localhost.localdomain/")).toThrow();
  });

  it("rejects .internal and .local hostnames", () => {
    expect(() => validateFetchUrl("http://api.internal/")).toThrow(/private/i);
    expect(() => validateFetchUrl("http://printer.local/")).toThrow(/private/i);
  });

  it("rejects IPv4 loopback literals", () => {
    expect(() => validateFetchUrl("http://127.0.0.1/")).toThrow(/loopback|private/i);
    expect(() => validateFetchUrl("http://127.42.0.9/")).toThrow();
  });

  it("rejects IPv4 private ranges", () => {
    expect(() => validateFetchUrl("http://10.0.0.1/")).toThrow(/private/i);
    expect(() => validateFetchUrl("http://172.16.0.1/")).toThrow();
    expect(() => validateFetchUrl("http://172.31.255.254/")).toThrow();
    expect(() => validateFetchUrl("http://192.168.1.1/")).toThrow();
  });

  it("rejects IPv4 link-local and CGNAT", () => {
    expect(() => validateFetchUrl("http://169.254.169.254/")).toThrow();
    expect(() => validateFetchUrl("http://100.64.0.1/")).toThrow();
  });

  it("accepts other public IPv4 ranges", () => {
    expect(() => validateFetchUrl("http://8.8.8.8/")).not.toThrow();
    expect(() => validateFetchUrl("http://172.32.0.1/")).not.toThrow();
    expect(() => validateFetchUrl("http://172.15.255.255/")).not.toThrow();
  });

  it("rejects IPv6 loopback and link-local", () => {
    expect(() => validateFetchUrl("http://[::1]/")).toThrow();
    expect(() => validateFetchUrl("http://[fe80::1]/")).toThrow();
    expect(() => validateFetchUrl("http://[fc00::1]/")).toThrow();
  });

  it("rejects 0.0.0.0", () => {
    expect(() => validateFetchUrl("http://0.0.0.0/")).toThrow();
  });
});
