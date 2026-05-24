/**
 * Short, URL-safe identifiers.
 *
 * UUIDs work fine functionally but their dashes and fixed v4 layout
 * make URLs noisy (`/rooms/3f7c1d62-1a2e-4b3a-9f2d-2c8e9a1b4c5d/...`).
 * We replace them with 32-character base64url strings drawn from 24
 * random bytes (192 bits of entropy — well above UUIDv4's 122).
 *
 *   shortId() → "x7Qz9_KaH4tVbN3mR6sLpY1cZ8wT2eF0"
 *
 * The character set is `[A-Za-z0-9_-]`, safe to drop into any URL path
 * or query parameter without percent-encoding.
 */

/** Generate a 32-char base64url identifier (24 random bytes, 192 bits). */
export function shortId(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return base64urlEncode(bytes);
}

/** Encode bytes as base64url with no padding. */
function base64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
