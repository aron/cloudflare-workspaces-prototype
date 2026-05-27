/**
 * Pull-scope matcher used by getDirtyNodes / pullDirty to drop paths
 * the caller doesn't want synced back to the DO.
 *
 * Each entry in `ignore` is a path segment (no slashes), and a path is
 * ignored if it contains `/<seg>/` or ends with `/<seg>`. Cheap
 * substring scan, no glob library. Covers the realistic cases
 * (`node_modules`, `.git`, `.cache`) without an extra dep.
 */
export function makeIgnore(ignore?: string[]): (p: string) => boolean {
  const segs = (ignore ?? []).filter(s => s.length > 0);
  if (segs.length === 0) return _p => false;
  return (p: string) => {
    for (const s of segs) {
      const needle = '/' + s;
      let i = p.indexOf(needle);
      while (i !== -1) {
        const after = i + needle.length;
        if (after === p.length || p.charCodeAt(after) === 0x2f /* '/' */) return true;
        i = p.indexOf(needle, after);
      }
    }
    return false;
  };
}
