import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, onTestFinished, test } from "vitest";

// Confirm WSD_DEFAULT_PORT on the build host stamps into the bundled
// source so downstream builds can fix a custom default without
// patching source. The bundle script is exercised directly; the
// runtime PORT env still wins (covered separately by the CLI
// integration tests).

const here = path.dirname(fileURLToPath(import.meta.url));
const distEntry = path.resolve(here, "../../dist/cli/wsd.cjs");
const bundleScript = path.resolve(here, "../../scripts/sea/bundle.mjs");

type BundleWsd = (opts: {
  outfile: string;
  target: { libfuseName: string; envVar: string };
}) => Promise<void>;

async function loadBundler(ctx: {
  skip: (reason?: string) => void;
}): Promise<BundleWsd | undefined> {
  try {
    await fs.access(distEntry);
  } catch {
    ctx.skip("dist/cli/wsd.cjs not built; run `npm run build` first");
    return undefined;
  }
  const mod = (await import(bundleScript)) as { bundleWsd: BundleWsd };
  return mod.bundleWsd;
}

test("WSD_DEFAULT_PORT stamps into the SEA bundle", async (ctx) => {
  const bundleWsd = await loadBundler(ctx);
  if (bundleWsd === undefined) return;

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "wsd-bundle-"));
  onTestFinished(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
    delete process.env.WSD_DEFAULT_PORT;
  });
  const outfile = path.join(tmp, "wsd.bundle.mjs");
  process.env.WSD_DEFAULT_PORT = "12345";

  await bundleWsd({
    outfile,
    target: { libfuseName: "libfuse.so.2", envVar: "LD_LIBRARY_PATH" },
  });

  const bundle = await fs.readFile(outfile, "utf8");
  // esbuild's `define` produces `const DEFAULT_PORT = 12345 ?? 45678;`
  // (or similar). Either way, the literal 12345 should appear.
  expect(bundle).toMatch(/12345/);
});

test("missing WSD_DEFAULT_PORT keeps the in-source 45678 fallback", async (ctx) => {
  const bundleWsd = await loadBundler(ctx);
  if (bundleWsd === undefined) return;

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "wsd-bundle-"));
  onTestFinished(async () => fs.rm(tmp, { recursive: true, force: true }));
  const outfile = path.join(tmp, "wsd.bundle.mjs");
  delete process.env.WSD_DEFAULT_PORT;

  await bundleWsd({
    outfile,
    target: { libfuseName: "libfuse.so.2", envVar: "LD_LIBRARY_PATH" },
  });

  const bundle = await fs.readFile(outfile, "utf8");
  // Fallback literal must survive substitution.
  expect(bundle).toMatch(/45678/);
});

test("WSD_DEFAULT_PORT rejects non-integer values", async (ctx) => {
  const bundleWsd = await loadBundler(ctx);
  if (bundleWsd === undefined) return;

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "wsd-bundle-"));
  onTestFinished(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
    delete process.env.WSD_DEFAULT_PORT;
  });
  process.env.WSD_DEFAULT_PORT = "not-a-port";

  await expect(
    bundleWsd({
      outfile: path.join(tmp, "wsd.bundle.mjs"),
      target: { libfuseName: "libfuse.so.2", envVar: "LD_LIBRARY_PATH" },
    }),
  ).rejects.toThrow(/WSD_DEFAULT_PORT/);
});
