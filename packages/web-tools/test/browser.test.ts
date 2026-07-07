import { describe, expect, it, vi } from "vitest";
import {
  createBrowserFetchTool,
  createBrowserScreenshotTool,
} from "../src/browser.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function exec(tool: any, input: any) {
  return tool.execute(input, { toolCallId: "t1", messages: [] });
}

function pngResponse(bytes: Uint8Array): Response {
  return new Response(bytes, {
    status: 200,
    headers: { "content-type": "image/png" },
  });
}
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// A tiny fake PNG payload (not a real PNG; we only care about bytes → base64).
const FAKE_PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const FAKE_PNG_B64 = "iVBORw0KGgoBAgM=";

// ── screenshot ───────────────────────────────────────────────────────

describe("createBrowserScreenshotTool", () => {
  it("calls quickAction('screenshot') with url + mapped options", async () => {
    const quickAction = vi.fn().mockResolvedValue(pngResponse(FAKE_PNG));
    const tool = createBrowserScreenshotTool({ browser: { quickAction } });
    await exec(tool, {
      url: "https://example.com",
      fullPage: true,
      selector: "#main",
      type: "png",
      viewport: { width: 1280, height: 720 },
      gotoOptions: { waitUntil: "networkidle0", timeout: 45000 },
    });
    expect(quickAction).toHaveBeenCalledTimes(1);
    const [action, opts] = quickAction.mock.calls[0];
    expect(action).toBe("screenshot");
    expect(opts.url).toBe("https://example.com");
    expect(opts.selector).toBe("#main");
    expect(opts.viewport).toEqual({ width: 1280, height: 720 });
    expect(opts.gotoOptions).toEqual({ waitUntil: "networkidle0", timeout: 45000 });
    // Puppeteer-nested screenshot options.
    expect(opts.screenshotOptions.fullPage).toBe(true);
    expect(opts.screenshotOptions.type).toBe("png");
    // Binary encoding so we base64 it ourselves.
    expect(opts.screenshotOptions.encoding).toBe("binary");
  });

  it("rejects a private/loopback url before calling the browser", async () => {
    const quickAction = vi.fn();
    const tool = createBrowserScreenshotTool({ browser: { quickAction } });
    const out = await exec(tool, { url: "http://localhost:8080" });
    expect(out.error).toMatch(/loopback|localhost|private/i);
    expect(quickAction).not.toHaveBeenCalled();
  });

  it("rejects quality with png (endpoint 400s), allows it with jpeg", async () => {
    const quickAction = vi.fn().mockResolvedValue(pngResponse(FAKE_PNG));
    const tool = createBrowserScreenshotTool({ browser: { quickAction } });

    const bad = await exec(tool, { url: "https://x.com", type: "png", quality: 80 });
    expect(bad.error).toMatch(/quality/i);
    expect(quickAction).not.toHaveBeenCalled();

    await exec(tool, { url: "https://x.com", type: "jpeg", quality: 80 });
    const [, opts] = quickAction.mock.calls[0];
    expect(opts.screenshotOptions.quality).toBe(80);
    expect(opts.screenshotOptions.type).toBe("jpeg");
  });

  it("saves the image and returns metadata + a viewable path", async () => {
    const quickAction = vi.fn().mockResolvedValue(pngResponse(FAKE_PNG));
    const saveImage = vi.fn().mockResolvedValue({
      path: "/workspace/.screenshots/abc.png",
      url: "https://app/files/workspace/.screenshots/abc.png",
    });
    const tool = createBrowserScreenshotTool({ browser: { quickAction }, saveImage });
    const out = await exec(tool, { url: "https://example.com" });

    expect(saveImage).toHaveBeenCalledTimes(1);
    const [savedBytes, ext] = saveImage.mock.calls[0];
    expect(ext).toBe("png");
    expect(Array.from(savedBytes as Uint8Array)).toEqual(Array.from(FAKE_PNG));
    expect(out.path).toBe("/workspace/.screenshots/abc.png");
    // `url` stays the page URL; the saved location is `fileUrl`.
    expect(out.url).toBe("https://example.com");
    expect(out.fileUrl).toBe("https://app/files/workspace/.screenshots/abc.png");
    expect(out.mediaType).toBe("image/png");
    expect(out.bytes).toBe(FAKE_PNG.length);
    expect(out.error).toBeUndefined();
  });

  it("emits the image as model media only when vision is enabled", async () => {
    // Fresh Response per call — a Response body can only be read once.
    const quickAction = vi.fn().mockImplementation(() => pngResponse(FAKE_PNG));
    const visionTool = createBrowserScreenshotTool({
      browser: { quickAction },
      vision: true,
    });
    const out = await exec(visionTool, { url: "https://example.com" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const modelOut = (visionTool.toModelOutput as any)({
      toolCallId: "t1",
      input: { url: "https://example.com" },
      output: out,
    });
    expect(modelOut.type).toBe("content");
    const media = modelOut.value.find(
      (p: { type: string }) => p.type === "media",
    );
    expect(media.mediaType).toBe("image/png");
    expect(media.data).toBe(FAKE_PNG_B64);

    // Non-vision: text-only, no media (model can't see it).
    const textTool = createBrowserScreenshotTool({
      browser: { quickAction },
      vision: false,
    });
    const out2 = await exec(textTool, { url: "https://example.com" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const modelOut2 = (textTool.toModelOutput as any)({
      toolCallId: "t2",
      input: { url: "https://example.com" },
      output: out2,
    });
    expect(modelOut2.type).toBe("content");
    expect(
      modelOut2.value.some((p: { type: string }) => p.type === "media"),
    ).toBe(false);
  });

  it("surfaces a browser error response", async () => {
    const quickAction = vi.fn().mockResolvedValue(
      jsonResponse(
        { success: false, errors: [{ message: "navigation timeout" }] },
        422,
      ),
    );
    const tool = createBrowserScreenshotTool({ browser: { quickAction } });
    const out = await exec(tool, { url: "https://example.com" });
    expect(out.error).toMatch(/navigation timeout/);
  });
});

// ── markdown fetch ───────────────────────────────────────────────────

describe("createBrowserFetchTool", () => {
  it("calls quickAction('markdown') and returns the markdown", async () => {
    const quickAction = vi
      .fn()
      .mockResolvedValue(jsonResponse({ success: true, result: "# Hi\nbody" }));
    const tool = createBrowserFetchTool({ browser: { quickAction } });
    const out = await exec(tool, { url: "https://example.com" });
    expect(quickAction).toHaveBeenCalledWith(
      "markdown",
      expect.objectContaining({ url: "https://example.com" }),
    );
    expect(out.markdown).toBe("# Hi\nbody");
    expect(out.url).toBe("https://example.com");
    expect(out.error).toBeUndefined();
  });

  it("passes gotoOptions through for JS-heavy pages", async () => {
    const quickAction = vi
      .fn()
      .mockResolvedValue(jsonResponse({ success: true, result: "ok" }));
    const tool = createBrowserFetchTool({ browser: { quickAction } });
    await exec(tool, {
      url: "https://example.com",
      waitUntil: "networkidle0",
    });
    const [, opts] = quickAction.mock.calls[0];
    expect(opts.gotoOptions).toEqual({ waitUntil: "networkidle0" });
  });

  it("rejects a private/loopback url before calling the browser", async () => {
    const quickAction = vi.fn();
    const tool = createBrowserFetchTool({ browser: { quickAction } });
    const out = await exec(tool, { url: "http://127.0.0.1" });
    expect(out.error).toMatch(/private|loopback/i);
    expect(quickAction).not.toHaveBeenCalled();
  });

  it("surfaces a browser error response", async () => {
    const quickAction = vi.fn().mockResolvedValue(
      jsonResponse({ success: false, errors: [{ message: "bad page" }] }, 422),
    );
    const tool = createBrowserFetchTool({ browser: { quickAction } });
    const out = await exec(tool, { url: "https://example.com" });
    expect(out.error).toMatch(/bad page/);
  });

  it("handles a truncation cap on the returned markdown", async () => {
    const big = "x".repeat(5000);
    const quickAction = vi
      .fn()
      .mockResolvedValue(jsonResponse({ success: true, result: big }));
    const tool = createBrowserFetchTool({ browser: { quickAction }, maxChars: 1000 });
    const out = await exec(tool, { url: "https://example.com" });
    expect(out.markdown.length).toBe(1000);
    expect(out.truncated).toBe(true);
  });
});
