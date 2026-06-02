const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { detectFUSEBackend } = require("../../dist/fuse/index.js");

const packageRoot = path.resolve(__dirname, "../..");
const cliPath = path.join(packageRoot, "dist", "cli", "wsd.cjs");

test("wsd rejects relative MOUNT_POINT values", async () => {
  const port = await getAvailablePort();
  const child = spawn(cliPath, {
    cwd: packageRoot,
    env: { ...process.env, MOUNT_POINT: "relative-workspace", PORT: String(port) },
    stdio: ["ignore", "ignore", "pipe"],
  });

  const { code, stderr } = await waitForExit(child);
  assert.equal(code, 1);
  assert.match(stderr, /MOUNT_POINT must be an absolute path/);
});

test("wsd rejects non-numeric EXEC_LOG_MAX_BYTES values", async () => {
  // Boot the daemon with garbage in EXEC_LOG_MAX_BYTES; it should
  // refuse to start. Previously Number('foo') -> NaN silently
  // disabled log eviction (every append exceeded the cap).
  const port = await getAvailablePort();
  const child = spawn(cliPath, {
    cwd: packageRoot,
    env: {
      ...process.env,
      MOUNT_POINT: "/tmp/wsd-mount-not-used",
      PORT: String(port),
      EXEC_LOG_MAX_BYTES: "foo",
      DISABLE_FUSE: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });

  const { code, stderr } = await waitForExit(child);
  assert.equal(code, 1);
  assert.match(stderr, /EXEC_LOG_MAX_BYTES must be a positive integer/);
});

test("wsd appends to LOG_FILE when set, in addition to stdout/stderr", async (t) => {
  // Boot the daemon with LOG_FILE pointed at a temp file. The
  // startup banner line on stdout should also show up in the file,
  // proving the console patch landed and didn't replace the original
  // writers.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wsd-log-"));
  const logFile = path.join(dir, "wsd.log");
  const port = await getAvailablePort();
  const mountPoint = await fs.mkdtemp(path.join(os.tmpdir(), "wsd-mount-"));
  await startWsd(t, {
    port,
    mountPoint,
    env: { DISABLE_FUSE: "1", LOG_FILE: logFile },
  });
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const contents = await fs.readFile(logFile, "utf8");
  assert.match(contents, /\[info\] wsd listening on/);
});

test("wsd exposes file IO through the mounted filesystem", async (t) => {
  const backend = await detectFUSEBackend();
  if (backend.kind === "none") {
    t.skip(backend.reason);
    return;
  }

  const port = await getAvailablePort();
  const mountPoint = await fs.mkdtemp(path.join(os.tmpdir(), "wsd-mount-"));
  await startWsd(t, { port, mountPoint });

  const health = await request(`http://127.0.0.1:${port}/health`);
  assert.equal(health.statusCode, 200);
  assert.equal(health.body, "ok\n");

  const root = await request(`http://127.0.0.1:${port}/`);
  assert.equal(root.statusCode, 200);
  assert.deepEqual(JSON.parse(root.body), {});

  const info = await request(`http://127.0.0.1:${port}/__wsd/info`);
  assert.equal(info.statusCode, 200);
  assert.deepEqual(JSON.parse(info.body), {
    backend,
    mountPoint,
    port,
  });

  await fs.mkdir(path.join(mountPoint, "dir"));
  await fs.writeFile(path.join(mountPoint, "dir", "hello.txt"), "hello fuse");
  assert.equal(await fs.readFile(path.join(mountPoint, "dir", "hello.txt"), "utf8"), "hello fuse");
});

test("/ws serves a capnweb WorkspaceRPC session", async (t) => {
  const { createWorkspaceClient } = await import("@cloudflare/workspace-rpc/client");
  const port = await getAvailablePort();
  const mountPoint = await fs.mkdtemp(path.join(os.tmpdir(), "wsd-mount-"));
  await startWsd(t, { port, mountPoint, env: { DISABLE_FUSE: "1" } });

  const client = createWorkspaceClient({ url: `ws://127.0.0.1:${port}/ws` });
  try {
    // hasObjects against a fresh DB returns the empty subset.
    assert.deepEqual(await client.sync.hasObjects([]), []);
    // fetchChanges streams zero entries against a fresh DB.
    const stream = await client.sync.fetchChanges({ sinceRev: 0, ignore: [] });
    const reader = stream.getReader();
    const entries = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      entries.push(value);
    }
    assert.deepEqual(entries, []);
  } finally {
    await client.close();
  }
});

test("/api serves a capnweb HTTP-batch WorkspaceRPC session", async (t) => {
  const { newHttpBatchRpcSession } = await import("capnweb");
  const port = await getAvailablePort();
  const mountPoint = await fs.mkdtemp(path.join(os.tmpdir(), "wsd-mount-"));
  await startWsd(t, { port, mountPoint, env: { DISABLE_FUSE: "1" } });

  // HTTP batch flushes on first await; each call is a fresh session.
  const stub = newHttpBatchRpcSession(`http://127.0.0.1:${port}/api`);
  assert.deepEqual(await stub.sync.hasObjects([]), []);
});

test("wsd exposes file IO through the FUSE_SHIM userspace shim", async (t) => {
  // No FUSE backend required — the shim runs in user space and is
  // explicitly opt-in via FUSE_SHIM=1. Mirrors the real-FUSE test
  // above but for the dev fallback path.
  const port = await getAvailablePort();
  const mountPoint = await fs.mkdtemp(path.join(os.tmpdir(), "wsd-shim-"));
  await startWsd(t, { port, mountPoint, env: { FUSE_SHIM: "1" } });

  const info = await request(`http://127.0.0.1:${port}/__wsd/info`);
  assert.equal(info.statusCode, 200);
  const parsed = JSON.parse(info.body);
  assert.equal(parsed.backend.kind, "shim");
  assert.equal(parsed.mountPoint, mountPoint);

  // Disk → VFS: writing into the mount point should land in the VFS
  // and round-trip back through the shim onto disk.
  await fs.mkdir(path.join(mountPoint, "dir"));
  await fs.writeFile(path.join(mountPoint, "dir", "hello.txt"), "hello shim");
  assert.equal(await fs.readFile(path.join(mountPoint, "dir", "hello.txt"), "utf8"), "hello shim");
});

test("wsd rejects FUSE_SHIM=1 alongside DISABLE_FUSE=1", async () => {
  const port = await getAvailablePort();
  const child = spawn(cliPath, {
    cwd: packageRoot,
    env: {
      ...process.env,
      MOUNT_POINT: "/tmp/wsd-mount-not-used",
      PORT: String(port),
      FUSE_SHIM: "1",
      DISABLE_FUSE: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });

  const { code, stderr } = await waitForExit(child);
  assert.equal(code, 1);
  assert.match(stderr, /mutually exclusive/);
});

async function startWsd(
  t,
  {
    port,
    mountPoint,
    env = {},
  }: { port: number; mountPoint: string; env?: Record<string, string> },
) {
  const child = spawn(cliPath, {
    cwd: packageRoot,
    env: { ...process.env, MOUNT_POINT: mountPoint, PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  t.after(async () => {
    await stopProcess(child);
    await fs.rm(mountPoint, { recursive: true, force: true });
  });

  await waitForHTTPOK(`http://127.0.0.1:${port}/health`, child, () => stderr || stdout);
  return child;
}

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.equal(typeof address, "object");
      assert.notEqual(address, null);
      const port = address.port;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function waitForExit(child, timeoutMs = 2_000) {
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("timed out waiting for wsd to exit"));
    }, timeoutMs);

    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stderr });
    });
  });
}

async function waitForHTTPOK(url, child, output, timeoutMs = 5_000) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`wsd exited before becoming ready: ${child.exitCode}\n${output()}`);
    }

    try {
      const response = await request(url);
      if (response.statusCode === 200) return;
    } catch (error) {
      if (!isConnectionError(error)) throw error;
    }

    await delay(50);
  }

  throw new Error(`timed out waiting for ${url}\n${output()}`);
}

function request(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      response.setEncoding("utf8");
      let body = "";
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        resolve({ body, headers: response.headers, statusCode: response.statusCode });
      });
    });

    request.once("error", reject);
    request.setTimeout(1_000, () => {
      request.destroy(new Error(`request timed out: ${url}`));
    });
  });
}

function isConnectionError(error) {
  return error && ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"].includes(error.code);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stopProcess(child) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("timed out waiting for wsd to exit"));
    }, 2_000);

    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });

    child.kill("SIGTERM");
  });
}
