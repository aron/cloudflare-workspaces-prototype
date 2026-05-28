/**
 * Pick the render kind for a file based on its HEAD response and an
 * optional sniff of its first N bytes.
 *
 * Decision tree:
 *   image/*                         → image
 *   text/*, application/json, etc.  → text if under cap, else download
 *   anything else, under cap, sniff says text → text
 *   everything else                  → download
 *
 * Pure. The HEAD/sniff fetching lives in the hook.
 */

import { looksLikeUtf8Text } from "./utf8-sniff.js";

export type ViewerKind = "image" | "text" | "download";

export interface DecideKindInput {
  contentType: string;
  size: number;
  /** First N bytes of the file, for ambiguous content types. Optional. */
  sniffBytes?: Uint8Array;
}

export interface DecideKindOptions {
  /** Files larger than this are forced to download even if text. */
  maxTextBytes: number;
}

const TEXT_CONTENT_TYPES = [
  "text/",
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
];

function isTextContentType(ct: string): boolean {
  const lower = ct.toLowerCase();
  return TEXT_CONTENT_TYPES.some((prefix) => lower.startsWith(prefix));
}

export function decideKind(
  input: DecideKindInput,
  options: DecideKindOptions,
): ViewerKind {
  const { contentType, size, sniffBytes } = input;
  const { maxTextBytes } = options;

  if (contentType.toLowerCase().startsWith("image/")) return "image";

  if (isTextContentType(contentType)) {
    return size <= maxTextBytes ? "text" : "download";
  }

  // Unknown / generic binary type. Use the sniff bytes if provided and
  // the file is small enough to render inline.
  if (sniffBytes && size <= maxTextBytes && looksLikeUtf8Text(sniffBytes)) {
    return "text";
  }

  return "download";
}
