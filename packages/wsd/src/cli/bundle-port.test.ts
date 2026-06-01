const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

// Confirm WSD_DEFAULT_PORT on the build host stamps into the bundled
// source so downstream builds can fix a custom default without
// patching source. The bundle script is exercised directly; the
// runtime PORT env still wins (covered separately by the CLI
// integration tests).

const distEntry = path.resolve(__dirname, "../../dist/cli/wsd.cjs");
const bundleScript = path.resolve(__dirname, "../../scripts/sea/bundle.mjs");

async function loadBundler(t: { skip: (reason: string) => void }) {
  try {
    await fs.access(distEntry);
  } catch {
    t.skip("dist/cli/wsd.cjs not built; run `npm run build` first");
    return undefined;
  }
  const mod = (await import(bundleScript)) as {
    bundleWsd: (opts: {
      outfile: string;
      target: { libfuseName: string; envVar: string };
    }) => Promise<void>;
  };
  return mod.bundleWsd;
}

test("WSD_DEFAULT_PORT stamps into the SEA bundle", async (t) => {
  const bundleWsd = await loadBundler(t);
  if (bundleWsd === undefined) return;

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "wsd-bundle-"));
  t.after(async () => {
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
  assert.match(bundle, /12345/);
});

test("missing WSD_DEFAULT_PORT keeps the in-source 45678 fallback", async (t) => {
  const bundleWsd = await loadBundler(t);
  if (bundleWsd === undefined) return;

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "wsd-bundle-"));
  t.after(async () => fs.rm(tmp, { recursive: true, force: true }));
  const outfile = path.join(tmp, "wsd.bundle.mjs");
  delete process.env.WSD_DEFAULT_PORT;

  await bundleWsd({
    outfile,
    target: { libfuseName: "libfuse.so.2", envVar: "LD_LIBRARY_PATH" },
  });

  const bundle = await fs.readFile(outfile, "utf8");
  // Fallback literal must survive substitution.
  assert.match(bundle, /45678/);
});

test("WSD_DEFAULT_PORT rejects non-integer values", async (t) => {
  const bundleWsd = await loadBundler(t);
  if (bundleWsd === undefined) return;

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "wsd-bundle-"));
  t.after(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
    delete process.env.WSD_DEFAULT_PORT;
  });
  process.env.WSD_DEFAULT_PORT = "not-a-port";

  await assert.rejects(
    () =>
      bundleWsd({
        outfile: path.join(tmp, "wsd.bundle.mjs"),
        target: { libfuseName: "libfuse.so.2", envVar: "LD_LIBRARY_PATH" },
      }),
    /WSD_DEFAULT_PORT/,
  );
});
