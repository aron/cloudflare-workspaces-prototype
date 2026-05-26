/**
 * Tests for the read-only mount machinery in `@cloudflare/workspace`.
 *
 * Uses a fake in-memory `Mount` rather than R2 so the assertions stay
 * focused on the workspace plumbing (lazy index, per-file content fetch,
 * write rejection, persistence across re-instantiation, concurrent dedupe).
 * The R2 adapter is a thin wrapper around the `Mount` interface.
 *
 * Hosted in a dedicated DO (`MountHost`) whose only purpose is to give the
 * test body access to a real `DurableObjectState.storage` via
 * `runInDurableObject`.
 */

import { describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { Workspace, type Mount, type MountEntry } from "@cloudflare/workspace";
import type { MountHost } from "./mount-host.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

declare global {
  namespace Cloudflare {
    interface Env {
      MountHost: DurableObjectNamespace<MountHost>;
    }
  }
}

function stubFor(name: string) {
  const id = env.MountHost.idFromName(name);
  return env.MountHost.get(id);
}

/**
 * Build a fake mount + call counters from a flat `relPath -> body` map.
 * Passing `{ writable: true }` produces a read-write mount whose `put`/
 * `delete` mutate the same backing map.
 */
function fakeMount(files: Record<string, string>, opts: { writable?: boolean } = {}) {
  const fetchCalls:  string[] = [];
  const putCalls:    Array<{ relPath: string; body: string }> = [];
  const deleteCalls: string[] = [];
  let listCalls = 0;
  const writable = !!opts.writable;
  const mount: Mount = {
    kind: "fake",
    writable,
    async list(): Promise<MountEntry[]> {
      listCalls++;
      const entries: MountEntry[] = [];
      const dirs = new Set<string>();
      for (const [path, body] of Object.entries(files)) {
        entries.push({ relPath: path, type: "file", size: body.length, mtime: 1000 });
        const parts = path.split("/");
        for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
      }
      for (const d of dirs) entries.push({ relPath: d, type: "dir" });
      return entries;
    },
    async fetch(relPath: string): Promise<Uint8Array> {
      fetchCalls.push(relPath);
      const body = files[relPath];
      if (body === undefined) throw new Error(`fake mount: not found: ${relPath}`);
      return enc.encode(body);
    },
  };
  if (writable) {
    mount.put = async (relPath, bytes) => {
      const body = dec.decode(bytes);
      putCalls.push({ relPath, body });
      files[relPath] = body;
    };
    mount.delete = async (relPath) => {
      deleteCalls.push(relPath);
      delete files[relPath];
    };
  }
  return {
    mount,
    counts: () => ({
      listCalls,
      fetchCalls:  [...fetchCalls],
      putCalls:    [...putCalls],
      deleteCalls: [...deleteCalls],
    }),
    backing: files,
  };
}

/**
 * Wire a Workspace inside the DO with one mount at `/mnt`.
 * Sandbox binding is unused in these tests so a cast-stub is fine.
 */
function workspaceWith(storage: DurableObjectStorage, mount: Mount): Workspace {
  return new Workspace({
    storage,
    sandbox:   {} as never,
    sessionId: "mount-host",
    mounts:    { "/mnt": mount },
  });
}

describe("Workspace mounts", () => {
  it("does not call list() during construction (lazy)", async () => {
    const { mount, counts } = fakeMount({ "a.txt": "hello" });
    const c = await runInDurableObject(stubFor("lazy-construct"), async (_o: MountHost, state: DurableObjectState) => {
      // Just construct \u2014 do not read.
      workspaceWith(state.storage, mount);
      return counts();
    });
    expect(c.listCalls).toBe(0);
    expect(c.fetchCalls).toEqual([]);
  });

  it("indexes on first read; readdir/stat see stubs without fetching content", async () => {
    const files = { "skills/agents-sdk/SKILL.md": "hello", "skills/cf/SKILL.md": "world" };
    const { mount, counts } = fakeMount(files);
    const out = await runInDurableObject(stubFor("index-first-read"), async (_o: MountHost, state: DurableObjectState) => {
      const ws       = workspaceWith(state.storage, mount);
      const entries  = await ws.readdir("/mnt/skills");
      const skillSt  = await ws.stat("/mnt/skills/agents-sdk/SKILL.md");
      return { entries, skillSt, counts: counts() };
    });
    expect(out.counts.listCalls).toBe(1);
    expect(out.counts.fetchCalls).toEqual([]);
    expect(out.entries).toContainEqual({ name: "agents-sdk", type: "dir" });
    expect(out.entries).toContainEqual({ name: "cf",         type: "dir" });
    expect(out.skillSt).toMatchObject({ type: "file", size: 5 });
  });

  it("fetches content on first readFile and caches it for subsequent reads", async () => {
    const { mount, counts } = fakeMount({ "a.txt": "hello", "b.txt": "world" });
    const out = await runInDurableObject(stubFor("read-fetches"), async (_o: MountHost, state: DurableObjectState) => {
      const ws = workspaceWith(state.storage, mount);
      const a1 = await ws.readFile("/mnt/a.txt");
      const a2 = await ws.readFile("/mnt/a.txt");
      const b  = await ws.readFile("/mnt/b.txt");
      return {
        a1: a1 && dec.decode(a1),
        a2: a2 && dec.decode(a2),
        b:  b  && dec.decode(b),
        counts: counts(),
      };
    });
    expect(out.a1).toBe("hello");
    expect(out.a2).toBe("hello");
    expect(out.b).toBe("world");
    expect(out.counts.fetchCalls.sort()).toEqual(["a.txt", "b.txt"]);
  });

  it("rejects writes anywhere under a mount root", async () => {
    const { mount } = fakeMount({ "a.txt": "hi" });
    const out = await runInDurableObject(stubFor("readonly"), async (_o: MountHost, state: DurableObjectState) => {
      const ws = workspaceWith(state.storage, mount);
      const errors: string[] = [];
      const ops: Array<() => Promise<unknown>> = [
        () => ws.writeFile("/mnt/a.txt", "x"),
        () => ws.writeFile("/mnt/new.txt", "x"),
        () => ws.mkdir("/mnt/sub"),
        () => ws.deleteFile("/mnt/a.txt"),
      ];
      for (const op of ops) {
        try { await op(); errors.push("no-throw"); }
        catch (e) { errors.push((e as Error).message); }
      }
      await ws.writeFile("/free/ok.txt", "yes");
      const free = await ws.readFile("/free/ok.txt");
      return { errors, free: free && dec.decode(free) };
    });
    for (const e of out.errors) expect(e).toMatch(/EROFS/);
    expect(out.free).toBe("yes");
  });

  it("dedupes concurrent reads of the same stub (single fetch)", async () => {
    const { mount, counts } = fakeMount({ "a.txt": "x" });
    const c = await runInDurableObject(stubFor("concurrent"), async (_o: MountHost, state: DurableObjectState) => {
      const ws = workspaceWith(state.storage, mount);
      await Promise.all([
        ws.readFile("/mnt/a.txt"),
        ws.readFile("/mnt/a.txt"),
        ws.readFile("/mnt/a.txt"),
      ]);
      return counts();
    });
    expect(c.fetchCalls).toEqual(["a.txt"]);
  });

  it("persists the index across Workspace instantiations", async () => {
    const files = { "a.txt": "hello", "b.txt": "world" };

    // First instantiation: index + read one file.
    const first = await runInDurableObject(stubFor("persistence"), async (_o: MountHost, state: DurableObjectState) => {
      const fm  = fakeMount(files);
      const ws  = workspaceWith(state.storage, fm.mount);
      await ws.readFile("/mnt/a.txt");
      return fm.counts();
    });
    expect(first.listCalls).toBe(1);

    // Second instantiation against the same DO storage: no re-list,
    // a.txt is already hydrated, b.txt is still a stub.
    const second = await runInDurableObject(stubFor("persistence"), async (_o: MountHost, state: DurableObjectState) => {
      const fm  = fakeMount(files);
      const ws  = workspaceWith(state.storage, fm.mount);
      const a   = await ws.readFile("/mnt/a.txt");
      const b   = await ws.readFile("/mnt/b.txt");
      return { a: a && dec.decode(a), b: b && dec.decode(b), counts: fm.counts() };
    });
    expect(second.counts.listCalls).toBe(0);
    expect(second.counts.fetchCalls).toEqual(["b.txt"]);
    expect(second.a).toBe("hello");
    expect(second.b).toBe("world");
  });

  it("prefetch hydrates every stub under the mount root", async () => {
    const { mount, counts } = fakeMount({
      "a.txt":     "1",
      "sub/b.txt": "2",
      "sub/c.txt": "3",
    });
    const c = await runInDurableObject(stubFor("prefetch"), async (_o: MountHost, state: DurableObjectState) => {
      const ws = workspaceWith(state.storage, mount);
      await ws.prefetch("/mnt");
      return counts();
    });
    expect(c.fetchCalls.sort()).toEqual(["a.txt", "sub/b.txt", "sub/c.txt"]);
  });

  it("synthesizes intermediate directories from slash-delimited keys", async () => {
    const { mount } = fakeMount({ "a/b/c/leaf.txt": "x" });
    const out = await runInDurableObject(stubFor("dir-synth"), async (_o: MountHost, state: DurableObjectState) => {
      const ws = workspaceWith(state.storage, mount);
      return {
        a:   await ws.readdir("/mnt/a"),
        b:   await ws.readdir("/mnt/a/b"),
        c:   await ws.readdir("/mnt/a/b/c"),
      };
    });
    expect(out.a).toContainEqual({ name: "b",        type: "dir" });
    expect(out.b).toContainEqual({ name: "c",        type: "dir" });
    expect(out.c).toContainEqual({ name: "leaf.txt", type: "file" });
  });

  // ---- writable mounts ----

  it("writeFile under a read-write mount pushes to the backing store and the VFS", async () => {
    const fm = fakeMount({ "a.txt": "hello" }, { writable: true });
    const out = await runInDurableObject(stubFor("rw-write"), async (_o: MountHost, state: DurableObjectState) => {
      const ws = workspaceWith(state.storage, fm.mount);
      await ws.writeFile("/mnt/a.txt",   "updated");
      await ws.writeFile("/mnt/new.txt", "created");
      const a   = await ws.readFile("/mnt/a.txt");
      const nw  = await ws.readFile("/mnt/new.txt");
      return { a: a && dec.decode(a), nw: nw && dec.decode(nw), counts: fm.counts() };
    });
    expect(out.a).toBe("updated");
    expect(out.nw).toBe("created");
    expect(out.counts.putCalls).toEqual([
      { relPath: "a.txt",   body: "updated" },
      { relPath: "new.txt", body: "created" },
    ]);
    expect(fm.backing["a.txt"]).toBe("updated");
    expect(fm.backing["new.txt"]).toBe("created");
  });

  it("writeFile failure on the mount leaves the VFS untouched", async () => {
    const fm = fakeMount({ "a.txt": "hello" }, { writable: true });
    fm.mount.put = async () => { throw new Error("R2 down"); };
    const out = await runInDurableObject(stubFor("rw-write-fail"), async (_o: MountHost, state: DurableObjectState) => {
      const ws = workspaceWith(state.storage, fm.mount);
      let threw = false;
      try { await ws.writeFile("/mnt/a.txt", "updated"); }
      catch { threw = true; }
      const a = await ws.readFile("/mnt/a.txt");
      return { threw, a: a && dec.decode(a) };
    });
    expect(out.threw).toBe(true);
    expect(out.a).toBe("hello");  // original content still served from R2
  });

  it("writeFile preserves the existing file's mode on overwrite", async () => {
    // Regression: a plain writeFile(path, bytes) used to clobber the mode
    // column with 0o100644, silently stripping the +x bit off any executable
    // script that got rewritten by the edit / write tools.
    const fm = fakeMount({ "run.sh": "#!/bin/sh\necho hi\n" }, { writable: true });
    const out = await runInDurableObject(stubFor("rw-write-mode"), async (_o: MountHost, state: DurableObjectState) => {
      const ws = workspaceWith(state.storage, fm.mount);
      // Mark the file as executable up-front (mimicking a git checkout of an
      // 0o100755 blob, or an explicit chmod via the workspace API).
      await ws.writeFile("/mnt/run.sh", "#!/bin/sh\necho hi\n", 0o100755);
      // Now overwrite without specifying a mode — must preserve 0o100755.
      await ws.writeFile("/mnt/run.sh", "#!/bin/sh\necho hello\n");
      const st = await ws.stat("/mnt/run.sh");
      return { mode: st?.mode };
    });
    expect(out.mode).toBe(0o100755);
  });

  it("deleteFile under a read-write mount deletes a single file from the backing store", async () => {
    const fm = fakeMount({ "a.txt": "x", "b.txt": "y" }, { writable: true });
    const out = await runInDurableObject(stubFor("rw-delete-file"), async (_o: MountHost, state: DurableObjectState) => {
      const ws = workspaceWith(state.storage, fm.mount);
      await ws.deleteFile("/mnt/a.txt");
      const a = await ws.readFile("/mnt/a.txt");
      const b = await ws.readFile("/mnt/b.txt");
      return { a, b: b && dec.decode(b), counts: fm.counts() };
    });
    expect(out.a).toBeNull();
    expect(out.b).toBe("y");
    expect(out.counts.deleteCalls).toEqual(["a.txt"]);
    expect(fm.backing).toEqual({ "b.txt": "y" });
  });

  it("deleteFile on a directory deletes every file in the subtree from the backing store", async () => {
    const fm = fakeMount(
      { "sub/a.txt": "1", "sub/b.txt": "2", "keep.txt": "3" },
      { writable: true },
    );
    const out = await runInDurableObject(stubFor("rw-delete-tree"), async (_o: MountHost, state: DurableObjectState) => {
      const ws = workspaceWith(state.storage, fm.mount);
      await ws.deleteFile("/mnt/sub");
      return {
        listed:  await ws.listFilesUnder("/mnt"),
        counts:  fm.counts(),
      };
    });
    expect(out.listed).toEqual(["/mnt/keep.txt"]);
    expect(out.counts.deleteCalls.sort()).toEqual(["sub/a.txt", "sub/b.txt"]);
    expect(fm.backing).toEqual({ "keep.txt": "3" });
  });

  it("mkdir under a read-write mount is VFS-only (no put to the backing store)", async () => {
    const fm = fakeMount({}, { writable: true });
    const out = await runInDurableObject(stubFor("rw-mkdir"), async (_o: MountHost, state: DurableObjectState) => {
      const ws = workspaceWith(state.storage, fm.mount);
      await ws.mkdir("/mnt/new-dir");
      const st = await ws.stat("/mnt/new-dir");
      return { st, counts: fm.counts() };
    });
    expect(out.st?.type).toBe("dir");
    expect(out.counts.putCalls).toEqual([]);
    expect(out.counts.deleteCalls).toEqual([]);
  });

  it("throws if a mount declares writable but is missing put/delete", async () => {
    const mount: Mount = {
      kind: "broken",
      writable: true,
      async list()  { return []; },
      async fetch() { throw new Error("never"); },
      // missing put/delete on purpose
    };
    const out = await runInDurableObject(stubFor("rw-broken"), async (_o: MountHost, state: DurableObjectState) => {
      const ws = workspaceWith(state.storage, mount);
      try {
        await ws.writeFile("/mnt/x.txt", "y");
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    });
    expect(out).toMatch(/missing put\/delete/);
  });
});
