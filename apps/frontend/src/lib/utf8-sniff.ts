/**
 * Decide whether a byte buffer looks like user-readable text.
 *
 * Rules:
 *   - empty → text (nothing to render is fine, definitely not binary)
 *   - any NUL byte → not text
 *   - must decode as valid UTF-8 (TextDecoder fatal mode)
 *   - >= 90% of decoded code points must be "printable" — tab/LF/CR or
 *     anything outside the C0 / C1 control ranges
 *
 * Tuned for an 8 KiB sniff window, but the function itself is window-
 * size-agnostic. Pure.
 */

const PRINTABLE_THRESHOLD = 0.9;

export function looksLikeUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.byteLength === 0) return true;

  // Fast reject: any NUL is a strong signal of binary content.
  for (let i = 0; i < bytes.byteLength; i++) {
    if (bytes[i] === 0x00) return false;
  }

  // Strict UTF-8 decode. If the buffer was cut mid-codepoint by a range
  // request, TextDecoder would throw — `ignoreBOM: false, fatal: true`
  // is what we want here; the caller can pad or retry if it cares.
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return false;
  }

  let printable = 0;
  for (const ch of decoded) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x09 || cp === 0x0a || cp === 0x0d) {
      printable++;
      continue;
    }
    // C0 controls (0x00..0x1F) minus the three above are non-printable.
    if (cp < 0x20) continue;
    // DEL.
    if (cp === 0x7f) continue;
    // C1 control range.
    if (cp >= 0x80 && cp <= 0x9f) continue;
    printable++;
  }

  const total = [...decoded].length;
  return total === 0 || printable / total >= PRINTABLE_THRESHOLD;
}
