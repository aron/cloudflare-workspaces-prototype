/**
 * Pull bytes from a `Response.body` reader until either the body ends or
 * `maxBytes` is reached, whichever happens first. The reader is explicitly
 * cancelled on early exit so the connection can be released — this is the
 * memory ceiling for the whole web tool.
 */
export interface CappedRead {
  bytes: Uint8Array;
  truncated: boolean;
}

export async function readResponseCapped(res: Response, maxBytes: number): Promise<CappedRead> {
  if (!res.body) return { bytes: new Uint8Array(0), truncated: false };
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = maxBytes - total;
      if (value.length >= remaining) {
        parts.push(value.subarray(0, remaining));
        total += remaining;
        truncated = true;
        break;
      }
      parts.push(value);
      total += value.length;
    }
  } finally {
    if (truncated) {
      // Hint the source to stop producing. Best-effort.
      reader.cancel().catch(() => {});
    } else {
      reader.releaseLock();
    }
  }

  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return { bytes: out, truncated };
}
