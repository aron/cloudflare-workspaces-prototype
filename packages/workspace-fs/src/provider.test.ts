import { describe, expect, it } from "vitest";
import { withDB } from "./fs/with-db.js";
import { SQLiteWorkspaceProvider } from "./provider.js";

// Each provider test gets a fresh DB via withDB, which the workers
// runner aliases to a DO-backed implementation. The provider holds
// no I/O resources of its own, so it's safe to construct inside the
// withDB callback and let the storage handle teardown.
async function withProvider<T>(fn: (p: SQLiteWorkspaceProvider) => T | Promise<T>): Promise<T> {
  return withDB((db) => fn(new SQLiteWorkspaceProvider(db, { now: () => 1000 })));
}

describe("SQLiteWorkspaceProvider — capability flags", () => {
  it("reports the supported feature set", async () => {
    await withProvider((p) => {
      expect(p.readonly).toBe(false);
      expect(p.supportsSymlinks).toBe(true);
      expect(p.supportsWatch).toBe(false);
    });
  });
});

describe("SQLiteWorkspaceProvider — implemented methods", () => {
  it("mkdirSync creates a directory", async () => {
    await withProvider((p) => {
      p.mkdirSync("/a", { mode: 0o755 });
      expect(p.existsSync("/a")).toBe(true);
    });
  });

  it("statSync returns a VirtualStats-shaped object", async () => {
    await withProvider((p) => {
      p.mkdirSync("/a", {});
      const s = p.statSync("/a");
      expect(s.isDirectory()).toBe(true);
      expect(s.isFile()).toBe(false);
      expect(s.isSymbolicLink()).toBe(false);
      // 0o40755 — S_IFDIR or permissions. Linux FUSE rejects a
      // stat without the file-type bits, so we always set them.
      expect(s.mode).toBe(0o40755);
      expect(typeof s.ino).toBe("number");
      expect(typeof s.mtimeMs).toBe("number");
      expect(s.mtime).toBeInstanceOf(Date);
    });
  });

  it("lstatSync returns the same shape as statSync today (no symlinks yet)", async () => {
    await withProvider((p) => {
      p.mkdirSync("/a", {});
      expect(p.lstatSync("/a").isDirectory()).toBe(true);
    });
  });

  it("readdirSync returns names by default and dirent objects with withFileTypes", async () => {
    await withProvider((p) => {
      p.mkdirSync("/a", {});
      p.mkdirSync("/b", {});
      expect(p.readdirSync("/")).toEqual(["a", "b"]);
      const dirents = p.readdirSync("/", { withFileTypes: true });
      expect(Array.isArray(dirents)).toBe(true);
      expect((dirents as Array<{ name: string; isDirectory(): boolean }>)[0].isDirectory()).toBe(
        true,
      );
    });
  });

  it("unlinkSync removes a file", async () => {
    await withProvider((p) => {
      p.writeFileSync("/a.txt", "hi");
      p.unlinkSync("/a.txt");
      expect(p.existsSync("/a.txt")).toBe(false);
    });
  });

  it("rmdirSync removes an empty directory", async () => {
    await withProvider((p) => {
      p.mkdirSync("/a", {});
      p.rmdirSync("/a");
      expect(p.existsSync("/a")).toBe(false);
    });
  });

  it("renameSync moves an entry", async () => {
    await withProvider((p) => {
      p.writeFileSync("/a", "x");
      p.renameSync("/a", "/b");
      expect(p.existsSync("/a")).toBe(false);
      expect(p.existsSync("/b")).toBe(true);
    });
  });

  it("writeFileSync + readFileSync round-trip a string", async () => {
    await withProvider((p) => {
      p.writeFileSync("/a.txt", "hello workspace");
      expect(p.readFileSync("/a.txt", "utf8")).toBe("hello workspace");
    });
  });

  it("writeFileSync + readFileSync round-trip bytes", async () => {
    await withProvider((p) => {
      p.writeFileSync("/a.bin", Buffer.from([1, 2, 3]));
      const back = p.readFileSync("/a.bin");
      expect(back).toBeInstanceOf(Buffer);
      expect(Array.from(back as Buffer)).toEqual([1, 2, 3]);
    });
  });

  it("existsSync returns true / false correctly", async () => {
    await withProvider((p) => {
      expect(p.existsSync("/missing")).toBe(false);
      p.mkdirSync("/d", {});
      expect(p.existsSync("/d")).toBe(true);
    });
  });

  it("realpathSync returns the canonical path", async () => {
    await withProvider((p) => {
      p.mkdirSync("/a", {});
      expect(p.realpathSync("/a/./../a")).toBe("/a");
    });
  });

  it("accessSync resolves for existing paths and throws ENOENT for missing", async () => {
    await withProvider((p) => {
      p.mkdirSync("/a", {});
      expect(() => p.accessSync("/a")).not.toThrow();
      expect(() => p.accessSync("/missing")).toThrowError(
        expect.objectContaining({ code: "ENOENT" }),
      );
    });
  });
});

describe("SQLiteWorkspaceProvider — unimplemented surface (stubs)", () => {
  it.each([
    ["appendFileSync", (p: SQLiteWorkspaceProvider) => p.appendFileSync("/x", "y")],
    ["copyFileSync", (p: SQLiteWorkspaceProvider) => p.copyFileSync("/x", "/y")],
    ["internalModuleStat", (p: SQLiteWorkspaceProvider) => p.internalModuleStat("/x")],

    ["watch", (p: SQLiteWorkspaceProvider) => p.watch("/x")],
    ["watchFile", (p: SQLiteWorkspaceProvider) => p.watchFile("/x")],
  ])("%s throws ENOSYS", async (_name, call) => {
    await withProvider((p) => {
      expect(() => call(p)).toThrowError(expect.objectContaining({ code: "ENOSYS" }));
    });
  });
});
