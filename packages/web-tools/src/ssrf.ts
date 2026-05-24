/**
 * SSRF gate. Rejects any URL that points at the local host, a private
 * network, a link-local address, or an unsafe scheme.
 *
 * This is a parse-and-static-check guard. We do not pin the resolved IP
 * because Cloudflare's egress already resolves the hostname on our behalf —
 * a DNS-rebinding attack would have to compromise the resolver itself. If
 * stronger guarantees are needed, layer a network ACL on top.
 */

const PRIVATE_SUFFIXES = [".internal", ".local", ".localhost"];

function parseIpv4(host: string): [number, number, number, number] | null {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(s => Number(s));
  if (parts.some(p => p < 0 || p > 255)) return null;
  return parts as [number, number, number, number];
}

function isPrivateIpv4(parts: [number, number, number, number]): boolean {
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 224) return true; // multicast 224/4 (loose)
  if (a >= 240) return true; // reserved 240/4 incl. 255.255.255.255
  return false;
}

function isPrivateIpv6(host: string): boolean {
  // Strip brackets and zone id; lowercase for prefix comparisons.
  const h = host.replace(/^\[/, "").replace(/\]$/, "").split("%")[0].toLowerCase();
  if (h === "::" || h === "::1") return true;
  if (h.startsWith("fe80:") || h.startsWith("fe80::")) return true; // link-local
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // unique local fc00::/7
  if (h.startsWith("ff")) return true; // multicast
  // IPv4-mapped: ::ffff:a.b.c.d
  const mapped = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) {
    const v4 = parseIpv4(mapped[1]);
    if (v4 && isPrivateIpv4(v4)) return true;
  }
  return false;
}

export function validateFetchUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Refusing scheme ${url.protocol} (only http: and https: are allowed)`);
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname === "" ) throw new Error("URL has no hostname");
  if (hostname === "localhost" || hostname.startsWith("localhost.")) {
    throw new Error("Refusing loopback hostname 'localhost'");
  }
  for (const suffix of PRIVATE_SUFFIXES) {
    if (hostname.endsWith(suffix)) {
      throw new Error(`Refusing private hostname suffix '${suffix}'`);
    }
  }

  const v4 = parseIpv4(hostname);
  if (v4 && isPrivateIpv4(v4)) {
    throw new Error(`Refusing private/loopback IPv4 address ${hostname}`);
  }
  // url.hostname strips brackets for IPv6; the colon check is enough to
  // identify them.
  if (hostname.includes(":") && isPrivateIpv6(hostname)) {
    throw new Error(`Refusing private/loopback IPv6 address ${hostname}`);
  }

  return url;
}
