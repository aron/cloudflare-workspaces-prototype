/**
 * Browser Run (Quick Actions) tools: `screenshot` and a markdown `webfetch`.
 *
 * Both call `env.BROWSER.quickAction(...)` — Cloudflare's managed headless
 * browser — so the page is rendered (HTML + JS) remotely. That also means the
 * request originates from Cloudflare's browser, not our Worker, so it can't
 * reach our internal network; we still keep a basic http(s)/private-host guard
 * to refuse obviously-internal targets the model might pass.
 *
 * Kept framework-light: the `browser` binding is typed structurally so this
 * package doesn't hard-depend on `@cloudflare/workers-types`, and `saveImage`
 * is injected so the host decides where a screenshot is persisted (workspace
 * VFS, R2, etc.) and what URL to surface.
 */
import { tool } from "ai";
import { z } from "zod";
import { validateFetchUrl } from "./ssrf.js";

/** Structural subset of the `BrowserRun` binding's `quickAction`. */
export interface BrowserLike {
  quickAction: (action: string, options: Record<string, unknown>) => Promise<Response>;
}

/** Result of persisting a screenshot; surfaced back to the model + UI. */
export interface SavedImage {
  /** Absolute VFS path the image was written to. */
  path: string;
  /** Optional public/app URL to view it. */
  url?: string;
}

export interface BrowserScreenshotToolOptions {
  browser: BrowserLike;
  /**
   * Persist the captured image. Receives the raw bytes and the file extension
   * (`png` | `jpeg` | `webp`); returns where it landed. Omit to skip saving
   * (the model still gets the image inline when `vision` is set).
   */
  saveImage?: (bytes: Uint8Array, ext: string) => Promise<SavedImage>;
  /**
   * Whether the active model can consume images. When true, the captured
   * screenshot is returned to the model as `media` content (it *sees* the
   * pixels); when false, only text + the saved path/URL is returned.
   */
  vision?: boolean;
}

export interface BrowserFetchToolOptions {
  browser: BrowserLike;
  /** Hard cap on returned markdown characters. Default 100k. */
  maxChars?: number;
}

const DEFAULT_MAX_CHARS = 100_000;

// ── shared helpers ───────────────────────────────────────────────────

interface BrowserError {
  success: false;
  errors?: Array<{ message?: string; detail?: string }>;
}

function browserErrorMessage(body: unknown, status: number): string {
  const e = body as BrowserError | null;
  const first = e?.errors?.[0];
  const msg = first?.message ?? first?.detail;
  return msg ? msg : `browser action failed (HTTP ${status})`;
}

const extForType: Record<string, string> = {
  png: "png",
  jpeg: "jpeg",
  webp: "webp",
};
const mediaTypeForType: Record<string, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

function toBase64(bytes: Uint8Array): string {
  // Chunked to avoid arg-count limits on large images.
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// ── screenshot ───────────────────────────────────────────────────────

const lifecycle = z.enum(["load", "domcontentloaded", "networkidle0", "networkidle2"]);

const screenshotInput = z.object({
  url: z.string().describe("Absolute http(s) URL to screenshot."),
  fullPage: z
    .boolean()
    .optional()
    .describe("Capture the entire scrollable page rather than just the viewport."),
  selector: z
    .string()
    .optional()
    .describe("CSS selector; screenshot only this element."),
  type: z
    .enum(["png", "jpeg", "webp"])
    .optional()
    .describe("Image format. Default png. `quality` requires jpeg or webp."),
  quality: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Compression quality 1-100 (jpeg/webp only)."),
  omitBackground: z
    .boolean()
    .optional()
    .describe("Hide the default white background (transparent png)."),
  viewport: z
    .object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      deviceScaleFactor: z.number().positive().optional(),
    })
    .optional()
    .describe("Browser viewport. Default 1920x1080."),
  gotoOptions: z
    .object({
      waitUntil: lifecycle.optional(),
      timeout: z.number().int().positive().optional(),
    })
    .optional()
    .describe("Navigation options. Use waitUntil networkidle0 for JS-heavy pages."),
  userAgent: z.string().optional().describe("Override the user agent string."),
});

export type ScreenshotInput = z.infer<typeof screenshotInput>;

interface ScreenshotResult {
  url: string;
  mediaType?: string;
  bytes?: number;
  path?: string;
  fileUrl?: string;
  /** Present only in the tool's own output; stripped from model media path. */
  base64?: string;
  vision?: boolean;
  error?: string;
}

export function createBrowserScreenshotTool(opts: BrowserScreenshotToolOptions) {
  const { browser, saveImage } = opts;
  const vision = opts.vision ?? false;

  return tool({
    description: [
      "Render a webpage in a real headless browser and capture a screenshot.",
      "Runs the page's HTML + JavaScript, then captures the fully-rendered",
      "result. Use for visual inspection, previews, or pages that only make",
      "sense visually.",
      vision
        ? "The captured image is returned to you inline so you can see it."
        : "The image is saved and a link returned (the active model can't view images inline).",
      "",
      "Options mirror the Browser Run screenshot endpoint: fullPage, selector,",
      "type (png/jpeg/webp), quality (jpeg/webp only), omitBackground, viewport,",
      "and gotoOptions.waitUntil (use networkidle0 for JS-heavy pages).",
    ].join("\n"),
    inputSchema: screenshotInput,
    execute: async (input: ScreenshotInput): Promise<ScreenshotResult> => {
      try {
        validateFetchUrl(input.url);
      } catch (err) {
        return { url: input.url, error: err instanceof Error ? err.message : String(err) };
      }

      const type = input.type ?? "png";
      if (input.quality !== undefined && type === "png") {
        return {
          url: input.url,
          error:
            "quality is only supported with type 'jpeg' or 'webp' (png + quality returns 400).",
        };
      }

      const screenshotOptions: Record<string, unknown> = {
        type,
        encoding: "binary",
      };
      if (input.fullPage !== undefined) screenshotOptions.fullPage = input.fullPage;
      if (input.quality !== undefined) screenshotOptions.quality = input.quality;
      if (input.omitBackground !== undefined)
        screenshotOptions.omitBackground = input.omitBackground;

      const options: Record<string, unknown> = {
        url: input.url,
        screenshotOptions,
      };
      if (input.selector) options.selector = input.selector;
      if (input.viewport) options.viewport = input.viewport;
      if (input.gotoOptions) options.gotoOptions = input.gotoOptions;
      if (input.userAgent) options.userAgent = input.userAgent;

      let res: Response;
      try {
        res = await browser.quickAction("screenshot", options);
      } catch (err) {
        return { url: input.url, error: `browser call failed: ${err instanceof Error ? err.message : String(err)}` };
      }

      if (!res.ok) {
        let body: unknown = null;
        try {
          body = await res.json();
        } catch {
          /* non-JSON error body */
        }
        return { url: input.url, error: browserErrorMessage(body, res.status) };
      }

      const bytes = new Uint8Array(await res.arrayBuffer());
      const mediaType = mediaTypeForType[type];
      const ext = extForType[type];

      const result: ScreenshotResult = {
        url: input.url,
        mediaType,
        bytes: bytes.length,
        vision,
      };

      if (saveImage) {
        try {
          const saved = await saveImage(bytes, ext);
          result.path = saved.path;
          if (saved.url) result.fileUrl = saved.url;
        } catch (err) {
          // Saving is best-effort; the model can still see the image (vision)
          // or at least learn the capture succeeded.
          result.error = `saved failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      // Carry the base64 so toModelOutput can emit media without re-fetching.
      if (vision) result.base64 = toBase64(bytes);

      return result;
    },
    // Feed the pixels to the model (vision) or a compact text summary otherwise.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    toModelOutput: ({ output }: { output: any }) => {
      const r = output as ScreenshotResult;
      if (r.error) {
        return { type: "content" as const, value: [{ type: "text" as const, text: `Screenshot failed: ${r.error}` }] };
      }
      const where = r.path
        ? ` Saved to ${r.path}${r.fileUrl ? ` (${r.fileUrl})` : ""}.`
        : "";
      const value: Array<
        | { type: "text"; text: string }
        | { type: "media"; data: string; mediaType: string }
      > = [
        {
          type: "text",
          text: `Screenshot of ${r.url} (${r.mediaType}, ${r.bytes} bytes).${where}`,
        },
      ];
      if (r.vision && r.base64 && r.mediaType) {
        value.push({ type: "media", data: r.base64, mediaType: r.mediaType });
      }
      return { type: "content" as const, value };
    },
  });
}

// ── markdown fetch ───────────────────────────────────────────────────

const fetchInput = z.object({
  url: z.string().describe("Absolute http(s) URL to fetch as Markdown."),
  waitUntil: lifecycle
    .optional()
    .describe("Navigation wait condition; use networkidle0 for JS-heavy pages."),
});

export type BrowserFetchInput = z.infer<typeof fetchInput>;

interface BrowserFetchResult {
  url: string;
  markdown?: string;
  truncated?: boolean;
  error?: string;
}

export function createBrowserFetchTool(opts: BrowserFetchToolOptions) {
  const { browser } = opts;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;

  return tool({
    description:
      "Fetch a URL and return it as Markdown, rendered in a real headless browser (runs JavaScript, so SPAs work). Private/loopback addresses are refused. Use waitUntil networkidle0 for JS-heavy pages.",
    inputSchema: fetchInput,
    execute: async (input: BrowserFetchInput): Promise<BrowserFetchResult> => {
      try {
        validateFetchUrl(input.url);
      } catch (err) {
        return { url: input.url, error: err instanceof Error ? err.message : String(err) };
      }

      const options: Record<string, unknown> = { url: input.url };
      if (input.waitUntil) options.gotoOptions = { waitUntil: input.waitUntil };

      let res: Response;
      try {
        res = await browser.quickAction("markdown", options);
      } catch (err) {
        return { url: input.url, error: `browser call failed: ${err instanceof Error ? err.message : String(err)}` };
      }

      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        /* fall through to error handling */
      }

      if (!res.ok || !(body as { success?: boolean } | null)?.success) {
        return { url: input.url, error: browserErrorMessage(body, res.status) };
      }

      const raw = String((body as { result?: unknown }).result ?? "");
      const truncated = raw.length > maxChars;
      return {
        url: input.url,
        markdown: truncated ? raw.slice(0, maxChars) : raw,
        truncated,
      };
    },
  });
}
