/**
 * R2-backed implementation of `Mount` (lazy strategy).
 *
 * Lists every object under `prefix` once (paginated via R2's `cursor`),
 * synthesizes a directory tree from the slash-delimited keys, and fetches
 * file bytes one object at a time via `binding.get(key)`. File content is
 * stubbed into the VFS at index time and hydrated per-file on demand.
 *
 * The factory takes the live R2Bucket binding from the Worker's env, so the
 * caller is responsible for declaring the binding in wrangler.jsonc.
 */

import type { LazyMount, MountEntry, MountFactory } from "./index.js";

export interface R2MountOptions {
  /**
   * Object-key prefix inside the bucket. Defaults to "" (mount the whole
   * bucket). Leading "/" is stripped; a trailing "/" is added if missing
   * and the prefix is non-empty.
   */
  prefix?: string;
  /**
   * Access mode. Defaults to `"read-only"`. When `"read-write"`, writes
   * to the VFS under the mount root are propagated to R2 via put/delete;
   * container-side writes pulled back via `exec()` are also mirrored.
   */
  mode?: "read-only" | "read-write";
}

/**
 * Build a mount factory backed by an R2 bucket binding.
 *
 * @example
 *   mounts: {
 *     "/workspace/.agents/skills": R2Bucket(env.SHARED_FILES, { prefix: ".agents/skills" }),
 *     "/workspace/scratch":        R2Bucket(env.SCRATCH,      { mode: "read-write" }),
 *   }
 */
export function R2Bucket(binding: R2Bucket, opts: R2MountOptions = {}): MountFactory {
  const prefix   = normalizePrefix(opts.prefix ?? "");
  const writable = opts.mode === "read-write";

  return (_ctx) => {
    const mount: LazyMount = {
      kind: "r2",
      strategy: "lazy",
      writable,

      async list(): Promise<MountEntry[]> {
        const entries  = new Map<string, MountEntry>();   // relPath -> entry
        const dirs     = new Set<string>();
        let cursor: string | undefined;

        // Paginate. R2's list() returns up to 1000 objects per page.
        // `truncated` flips to false on the final page.
        while (true) {
          const page: R2Objects = await binding.list({ prefix, cursor, limit: 1000 });
          for (const obj of page.objects) {
            if (!obj.key.startsWith(prefix)) continue;
            const relPath = obj.key.slice(prefix.length);
            if (!relPath || relPath.endsWith("/")) continue;  // skip directory markers

            entries.set(relPath, {
              relPath,
              type:  "file",
              size:  obj.size,
              mtime: obj.uploaded ? obj.uploaded.getTime() : undefined,
            });

            // Synthesize parent directories from path segments.
            const parts = relPath.split("/");
            for (let i = 1; i < parts.length; i++) {
              dirs.add(parts.slice(0, i).join("/"));
            }
          }
          if (!page.truncated) break;
          cursor = page.cursor;
          if (!cursor) break;
        }

        for (const dir of dirs) {
          if (!entries.has(dir)) entries.set(dir, { relPath: dir, type: "dir" });
        }
        return [...entries.values()];
      },

      async fetch(relPath: string): Promise<Uint8Array> {
        const key  = prefix + relPath;
        const obj  = await binding.get(key);
        if (!obj) throw new Error(`R2 object not found: ${key}`);
        const buf  = await obj.arrayBuffer();
        return new Uint8Array(buf);
      },
    };

    if (writable) {
      mount.put = async (relPath: string, bytes: Uint8Array): Promise<void> => {
        await binding.put(prefix + relPath, bytes);
      };
      mount.delete = async (relPath: string): Promise<void> => {
        await binding.delete(prefix + relPath);
      };
    }

    return mount;
  };
}

function normalizePrefix(p: string): string {
  let out = p;
  while (out.startsWith("/")) out = out.slice(1);
  if (out.length > 0 && !out.endsWith("/")) out += "/";
  return out;
}
