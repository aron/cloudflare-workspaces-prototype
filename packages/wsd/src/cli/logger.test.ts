const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

// Pure logger primitives: a single appendToLogFile that's idempotent
// over a file handle and a formatError that surfaces stack traces.
// Wiring into console.{log,error} and into process.on('uncaughtException')
// lives in wsd.ts and is exercised end-to-end in wsd.test.ts; the unit
// tests here pin the helper contract so a regression on either side
// can be diagnosed without booting the daemon.

const { createFileLogger, formatLogEntry, installLogging } = require("../../dist/cli/logger.js");

test("formatLogEntry: stringifies primitives and Error objects", () => {
  assert.match(formatLogEntry("info", ["plain string"]), /plain string/);
  assert.match(formatLogEntry("info", [42, "and", true]), /42 and true/);
  const err = new Error("boom");
  const out = formatLogEntry("error", [err]);
  assert.match(out, /Error: boom/);
  assert.match(out, /at /); // stack frame
});

test("formatLogEntry: prefixes with ISO timestamp and level", () => {
  const out = formatLogEntry("info", ["hi"]);
  // ISO date prefix + level tag.
  assert.match(out, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  assert.match(out, /\[info\]/);
  const errOut = formatLogEntry("error", ["bad"]);
  assert.match(errOut, /\[error\]/);
});

test("createFileLogger: appends entries to the given path", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "wsd-logger-"));
  const logPath = path.join(dir, "wsd.log");
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const logger = createFileLogger(logPath);
  logger.write("info", ["first"]);
  logger.write("error", ["second"]);
  logger.close();

  const contents = await fsp.readFile(logPath, "utf8");
  assert.match(contents, /\[info\] first/);
  assert.match(contents, /\[error\] second/);
});

test("createFileLogger: appends (does not truncate) when reopening", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "wsd-logger-"));
  const logPath = path.join(dir, "wsd.log");
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  // Seed with a prior session.
  await fsp.writeFile(logPath, "previous session\n", "utf8");

  const logger = createFileLogger(logPath);
  logger.write("info", ["new line"]);
  logger.close();

  const contents = await fsp.readFile(logPath, "utf8");
  assert.match(contents, /previous session/);
  assert.match(contents, /new line/);
});

test("createFileLogger: creates the file if it doesn't exist", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "wsd-logger-"));
  const logPath = path.join(dir, "nested/wsd.log");
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const logger = createFileLogger(logPath);
  logger.write("info", ["hello"]);
  logger.close();

  assert.ok(fs.existsSync(logPath));
});

test("installLogging: mirrors console.{log,error} into the log file", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "wsd-logger-"));
  const logPath = path.join(dir, "wsd.log");
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const teardown = installLogging(logPath);
  try {
    console.log("info via console.log");
    console.error("error via console.error");
  } finally {
    teardown();
  }

  const contents = await fsp.readFile(logPath, "utf8");
  assert.match(contents, /\[info\] info via console\.log/);
  assert.match(contents, /\[error\] error via console\.error/);
});

test("installLogging: restores console methods on teardown", () => {
  const originalLog = console.log;
  const originalError = console.error;
  const teardown = installLogging(undefined);
  // Without a LOG_FILE the install still wraps the console methods
  // (so uncaught handlers see the same formatting); teardown restores.
  assert.notEqual(console.log, originalLog);
  assert.notEqual(console.error, originalError);
  teardown();
  assert.equal(console.log, originalLog);
  assert.equal(console.error, originalError);
});

test("installLogging: uncaughtException handler writes to LOG_FILE before exit", async (t) => {
  // Spawn a tiny Node script that imports installLogging, then
  // throws asynchronously to trigger uncaughtException. The exit
  // code should be 1 and the log file should contain the formatted
  // error.
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "wsd-logger-"));
  const logPath = path.join(dir, "wsd.log");
  const scriptPath = path.join(dir, "crash.cjs");
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const loggerPath = path.resolve(__dirname, "../../dist/cli/logger.js");
  const script = [
    `const { installLogging } = require(${JSON.stringify(loggerPath)});`,
    `installLogging(${JSON.stringify(logPath)});`,
    `setImmediate(() => { throw new Error("deliberate crash"); });`,
  ].join("\n");
  await fsp.writeFile(scriptPath, script, "utf8");

  const { spawn } = require("node:child_process");
  const child = spawn(process.execPath, [scriptPath], { stdio: ["ignore", "ignore", "pipe"] });
  const code = await new Promise((resolve) => {
    child.once("exit", (c) => resolve(c));
  });
  assert.equal(code, 1);
  const contents = await fsp.readFile(logPath, "utf8");
  assert.match(contents, /uncaughtException/);
  assert.match(contents, /deliberate crash/);
});
