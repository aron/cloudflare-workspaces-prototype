/**
 * Tiny MIME-type table for the agent's `/files/*` route.
 *
 * We don't need the full mime-db — a handful of common image, document,
 * audio, and video types covers everything an agent is likely to ask the
 * user to view in-browser or download. Unknown text-shaped extensions
 * fall back to `text/plain`, everything else to `application/octet-stream`
 * so the browser doesn't try to render binary content as HTML.
 */

const BINARY: Record<string, string> = {
  png:  "image/png",
  jpg:  "image/jpeg",
  jpeg: "image/jpeg",
  gif:  "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico:  "image/x-icon",
  bmp:  "image/bmp",
  svg:  "image/svg+xml",
  pdf:  "application/pdf",
  zip:  "application/zip",
  tar:  "application/x-tar",
  gz:   "application/gzip",
  wasm: "application/wasm",
  mp3:  "audio/mpeg",
  wav:  "audio/wav",
  ogg:  "audio/ogg",
  flac: "audio/flac",
  mp4:  "video/mp4",
  webm: "video/webm",
  mov:  "video/quicktime",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf:   "font/ttf",
  otf:   "font/otf",
};

const TEXTUAL: Record<string, string> = {
  txt:  "text/plain",
  md:   "text/markdown",
  json: "application/json",
  jsonc: "application/json",
  html: "text/html",
  htm:  "text/html",
  css:  "text/css",
  csv:  "text/csv",
  xml:  "application/xml",
  yaml: "application/yaml",
  yml:  "application/yaml",
};

// Extensions that are source code: served as text so the browser shows
// them inline. The list is open-ended on purpose — we'd rather treat
// unknown source extensions as text than as octet-stream.
const SOURCE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "go", "rs", "py", "rb",
  "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp", "zig",
  "sh", "bash", "zsh", "fish", "lua", "php", "pl", "r",
  "sql", "toml", "ini", "conf", "env", "gitignore", "dockerfile",
]);

/**
 * Return a Content-Type string for the given path.
 *
 * The returned value includes `; charset=utf-8` for textual types so
 * browsers render UTF-8 correctly without sniffing.
 */
export function guessMimeType(path: string): string {
  // Extract the extension after the last dot in the last path segment.
  // Fall back to the basename for extensionless files like `Makefile`.
  const slash = path.lastIndexOf("/");
  const base  = slash === -1 ? path : path.slice(slash + 1);
  const dot   = base.lastIndexOf(".");
  const key   = (dot === -1 ? base : base.slice(dot + 1)).toLowerCase();

  const binary = BINARY[key];
  if (binary) return binary;

  const textual = TEXTUAL[key];
  if (textual) return `${textual}; charset=utf-8`;

  // Bare names without extensions that are conventionally source files.
  if (dot === -1 && /^[a-z]+$/i.test(base)) {
    return "text/plain; charset=utf-8";
  }

  if (SOURCE_EXTENSIONS.has(key)) return "text/plain; charset=utf-8";

  return "application/octet-stream";
}
