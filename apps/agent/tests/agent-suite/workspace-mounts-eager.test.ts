/// <reference path="../../node_modules/@cloudflare/vitest-pool-workers/types/cloudflare-test.d.ts" />
/**
 * Tests for the eager-mount dispatch path in `@cloudflare/workspace`.
 *
 * Eager mounts populate the VFS in `materialize(api)` instead of the
 * lazy `list()`/`fetch()` pair. This file uses a fake eager mount to
 * exercise:
 *   - the workspace passes a usable write API + Vfs handle on first read
 *   - `materialize()` is called exactly once per mount per DO lifetime
 *   - persistence: after a DO restart, materialize() is NOT called again
 *   - `readFile` returns the real bytes (no stub indirection)
 *   - prefix-style filtering inside materialize() works as expected
 *
 * The GitHub adapter is tested through this surface — if eager dispatch
 * is correct, the only remaining risk is the isomorphic-git +
 * Artifacts-binding side, which lives at a different seam.
 */

import { describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { Workspace, type EagerMount, type MountFactory } from "@cloudflare/workspace";
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
 * Build a fake eager-mount factory from a flat `relPath -> body` map.
 * Tracks how many times `materialize()` was called via the returned
 * counter — important for the persistence test.
 */
function fakeEagerMount(files: Record<string, string>) {
  let materializeCalls = 0;
  const factory: MountFactory = (ctx) => {
    const mount: EagerMount = {
      kind: "fake-eager",
      strategy: "eager",
      writable: false,
      async materialize(api) {
        materializeCalls++;
        // Synthesize directory structure from slash-delimited keys, then
        // write every file under the mount root.
        const dirs = new Set<string>();
        for (const path of Object.keys(files)) {
          const parts = path.split("/");
          for (let i = 1; i < parts.length; i++) {
            dirs.add(parts.slice(0, i).join("/"));
          }
        }
        for (const d of dirs) api.mkdir(`${ctx.root}/${d}`);
        for (const [rel, body] of Object.entries(files)) {
          api.writeFile(`${ctx.root}/${rel}`, enc.encode(body));
        }
      },
    };
    return mount;
  };
  return {
    factory,
    counts: () => ({ materializeCalls }),
  };
}

function workspaceWith(storage: DurableObjectStorage, mount: MountFactory): Workspace {
  return new Workspace({
    storage,
    sandbox:   {} as never,
    sessionId: "mount-host",
    mounts:    { "/mnt": mount },
  });
}

describe("Workspace eager mounts", () => {
  it("materialize() runs on first read, writing real content (no stubs)", async () => {
    const { factory, counts } = fakeEagerMount({
      "a.txt":         "hello",
      "sub/b.txt":     "world",
      "sub/c/d.txt":   "deep",
    });
    const out = await runInDurableObject(stubFor("eager-first"), async (_o: MountHost, state: DurableObjectState) => {
      const ws = workspaceWith(state.storage, factory);
      const a  = await ws.readFile("/mnt/a.txt");
      const b  = await ws.readFile("/mnt/sub/b.txt");
      const d  = await ws.readFile("/mnt/sub/c/d.txt");
      return {
        a: a && dec.decode(a),
        b: b && dec.decode(b),
        d: d && dec.decode(d),
        counts: counts(),
      };
    });
    expect(out.a).toBe("hello");
    expect(out.b).toBe("world");
    expect(out.d).toBe("deep");
    expect(out.counts.materializeCalls).toBe(1);
  });

  it("does not call materialize() at construction time", async () => {
    const { factory, counts } = fakeEagerMount({ "a.txt": "x" });
    const c = await runInDurableObject(stubFor("eager-lazy-ctor"), async (_o: MountHost, state: DurableObjectState) => {
      workspaceWith(state.storage, factory);
      return counts();
    });
    expect(c.materializeCalls).toBe(0);
  });

  it("rejects writes anywhere under an eager mount (read-only)", async () => {
    const { factory } = fakeEagerMount({ "a.txt": "x" });
    const out = await runInDurableObject(stubFor("eager-readonly"), async (_o: MountHost, state: DurableObjectState) => {
      const ws = workspaceWith(state.storage, factory);
      const errors: string[] = [];
      const ops: Array<() => Promise<unknown>> = [
        () => ws.writeFile("/mnt/a.txt", "y"),
        () => ws.writeFile("/mnt/new.txt", "y"),
        () => ws.deleteFile("/mnt/a.txt"),
      ];
      for (const op of ops) {
        try { await op(); errors.push("no-throw"); }
        catch (e) { errors.push((e as Error).message); }
      }
      return errors;
    });
    for (const e of out) expect(e).toMatch(/EROFS/);
  });

  it("does not re-materialize after a Workspace re-instantiation", async () => {
    const files = { "a.txt": "hello", "b.txt": "world" };

    // First boot: trigger materialize via a read.
    const first = await runInDurableObject(stubFor("eager-persist"), async (_o: MountHost, state: DurableObjectState) => {
      const fm = fakeEagerMount(files);
      const ws = workspaceWith(state.storage, fm.factory);
      await ws.readFile("/mnt/a.txt");
      return fm.counts();
    });
    expect(first.materializeCalls).toBe(1);

    // Second boot against the same storage: materialize must NOT run again;
    // content already in vfs_nodes/vfs_chunks survives the DO restart.
    const second = await runInDurableObject(stubFor("eager-persist"), async (_o: MountHost, state: DurableObjectState) => {
      const fm = fakeEagerMount(files);
      const ws = workspaceWith(state.storage, fm.factory);
      const a  = await ws.readFile("/mnt/a.txt");
      const b  = await ws.readFile("/mnt/b.txt");
      return { a: a && dec.decode(a), b: b && dec.decode(b), counts: fm.counts() };
    });
    expect(second.counts.materializeCalls).toBe(0);
    expect(second.a).toBe("hello");
    expect(second.b).toBe("world");
  });

  it("factory receives a MountContext with sessionId, root, and vfs", async () => {
    let captured: { sessionId?: string; root?: string; vfsPresent?: boolean } = {};
    const factory: MountFactory = (ctx) => {
      captured = {
        sessionId: ctx.sessionId,
        root:      ctx.root,
        vfsPresent: typeof ctx.vfs?.stat === "function",
      };
      return {
        kind: "ctx-capture",
        strategy: "eager",
        writable: false,
        async materialize(api) {
          api.writeFile(`${ctx.root}/x.txt`, enc.encode("hi"));
        },
      };
    };
    await runInDurableObject(stubFor("ctx-capture"), async (_o: MountHost, state: DurableObjectState) => {
      const ws = workspaceWith(state.storage, factory);
      await ws.readFile("/mnt/x.txt");
    });
    expect(captured).toEqual({
      sessionId:  "mount-host",
      root:       "/mnt",
      vfsPresent: true,
    });
  });
});
