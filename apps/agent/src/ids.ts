/**
 * Short, URL-safe identifiers.
 *
 * UUIDs work fine functionally but their dashes and fixed v4 layout
 * make URLs noisy (`/rooms/3f7c1d62-1a2e-4b3a-9f2d-2c8e9a1b4c5d/...`).
 * We take the 16 random bytes of a v4 UUID and re-encode them in
 * Crockford base32, yielding a flat 26-character identifier with the
 * same 122 bits of entropy as the source UUID.
 *
 *   shortId() → "k7qz9xah4tvbn3mr6slpy1cz8w"
 *
 * Crockford's alphabet (`0-9a-z` minus `i l o u`) is alphanumeric,
 * case-insensitive friendly, and dodges the visually ambiguous chars
 * (`0/o`, `1/i/l`) — nice when someone reads an id out loud or copies
 * one out of a chat log.
 */

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** Generate a 26-char Crockford base32 identifier (a v4 UUID re-encoded). */
export function shortId(): string {
  // `crypto.randomUUID()` returns a v4 UUID. Strip dashes, parse hex, encode.
  const hex = crypto.randomUUID().replace(/-/g, "");
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return base32Encode(bytes);
}

/**
 * Encode bytes as Crockford base32. 16-byte inputs from `shortId()`
 * produce 26 chars (the last char carries 3 data bits + 2 zero pad
 * bits, since 128 isn't a multiple of 5).
 */
function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let acc  = 0;
  for (let i = 0; i < bytes.length; i++) {
    acc  = (acc << 8) | bytes[i]!;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(acc >> bits) & 0x1f];
    }
  }
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 0x1f];
  return out;
}
