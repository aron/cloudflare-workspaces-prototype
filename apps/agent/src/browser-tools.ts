/**
 * Wires the Browser Run tools from `@cloudflare/web-tools` into the agent:
 *   - `webfetch`   — markdown fetch via `env.BROWSER.quickAction("markdown")`,
 *                    falling back to the AI-binding HTML→markdown tool when no
 *                    browser binding is present (tests/dev).
 *   - `screenshot` — capture via `quickAction("screenshot")`, saved to the
 *                    workspace VFS (so the file viewer can show it) and, for
 *                    vision-capable models, returned inline as image media.
 *
 * Kept out of agent.ts so the `saveImage` wiring + fallback logic is unit-
 * testable and shared by both the Agent and SubAgent tool sets.
 */
import {
  type BrowserLike,
  type SavedImage,
  createBrowserFetchTool,
  createBrowserScreenshotTool,
  createWebFetchTool,
} from "@cloudflare/web-tools";
import type { ToolSet } from "ai";
import { shortId } from "./ids.js";

/** Minimal workspace fs surface we need to persist a screenshot. */
export interface ScreenshotFs {
  writeFile(path: string, content: Uint8Array): Promise<void>;
  mkdir?(path: string, options?: { recursive?: boolean }): Promise<void>;
}

export interface BuildBrowserToolsDeps {
  /** Browser Run binding, when configured. */
  browser?: BrowserLike;
  /** Workers AI binding for the non-browser markdown fallback. */
  ai?: unknown;
  /** Resolve the workspace fs lazily (per call). */
  getFs: () => Promise<ScreenshotFs>;
  /** Whether the active model can consume images inline. */
  vision: boolean;
  /** Public app origin (APP_BASE_URL), for building viewable file URLs. */
  baseUrl?: string;
  /** Thread id — part of the `/api/threads/<id>/files/...` URL. */
  threadId: string;
}

/** Directory (in the VFS) where screenshots are written. */
export const SCREENSHOT_DIR = "/workspace/.screenshots";

/** Build a viewable URL for a workspace path, or undefined without a baseUrl. */
export function fileUrlFor(
  baseUrl: string | undefined,
  threadId: string,
  absPath: string,
): string | undefined {
  const origin = (baseUrl ?? "").replace(/\/+$/, "");
  if (!origin) return undefined;
  return `${origin}/api/threads/${threadId}/files${absPath}`;
}

/**
 * Build the browser-backed tool set. Always returns `webfetch`; returns
 * `screenshot` only when a browser binding is present (it has no meaningful
 * fallback). Returns a plain object ready to spread into `getTools()`.
 */
export function buildBrowserTools(deps: BuildBrowserToolsDeps): ToolSet {
  const tools: ToolSet = {};

  // webfetch: browser markdown when available, else the AI-binding fallback.
  tools.webfetch = deps.browser
    ? createBrowserFetchTool({ browser: deps.browser })
    : createWebFetchTool({ ai: deps.ai as never });

  if (deps.browser) {
    const saveImage = async (bytes: Uint8Array, ext: string): Promise<SavedImage> => {
      const fs = await deps.getFs();
      if (fs.mkdir) await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
      const path = `${SCREENSHOT_DIR}/${shortId()}.${ext}`;
      await fs.writeFile(path, bytes);
      const url = fileUrlFor(deps.baseUrl, deps.threadId, path);
      return url ? { path, url } : { path };
    };
    tools.screenshot = createBrowserScreenshotTool({
      browser: deps.browser,
      saveImage,
      vision: deps.vision,
    });
  }

  return tools;
}
