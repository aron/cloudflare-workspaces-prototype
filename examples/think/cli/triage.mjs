#!/usr/bin/env node
/**
 * triage <issue_url> [--worker URL] [--host HOST]
 *
 * Starts a tiny webhook server on 0.0.0.0:<random>, POSTs the issue
 * + the resolved webhook URL to the worker, and prints every
 * progress message that comes back. Exits 0 when a message ends in
 * "DONE"; exits non-zero on a 10-minute silence timeout or a worker
 * error response.
 *
 * Bound to 0.0.0.0 (not 127.0.0.1) so a worker running inside Docker
 * — or any other sandbox container on the same machine — can reach
 * back to the host. The advertised host name is the first
 * non-loopback IPv4 from os.networkInterfaces(); override with
 * --host or TRIAGE_HOST when that picks the wrong NIC.
 */

import http from "node:http";
import os from "node:os";
import { argv, env, exit } from "node:process";

// ── Args ───────────────────────────────────────────────────────────

const { issueUrl, workerUrl, advertiseHost, debug } = parseArgs(argv.slice(2));
if (!issueUrl) {
  process.stderr.write("usage: triage <issue_url> [--worker URL] [--host HOST] [--debug]\n");
  exit(2);
}

// ── Webhook server ─────────────────────────────────────────────────

const STILL_ALIVE_MS = 10 * 60 * 1000; // 10 min silence ⇒ give up
let watchdog;
function bumpWatchdog() {
  clearTimeout(watchdog);
  watchdog = setTimeout(() => {
    process.stderr.write(`\nNo webhook traffic for ${STILL_ALIVE_MS / 1000}s; giving up.\n`);
    exit(3);
  }, STILL_ALIVE_MS);
}

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/webhook") {
    res.writeHead(404).end();
    return;
  }
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 16 * 1024 * 1024) req.destroy(); // 16 MiB hard cap
  });
  req.on("end", () => {
    bumpWatchdog();
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400).end("bad json");
      return;
    }
    res.writeHead(204).end();
    handleWebhook(payload);
  });
});

server.listen(0, "0.0.0.0", async () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const host = advertiseHost || pickHost();
  const webhookUrl = `http://${host}:${port}/webhook`;
  process.stderr.write(`webhook listening on http://0.0.0.0:${port}/webhook\n`);
  process.stderr.write(`advertising as ${webhookUrl}\n`);
  bumpWatchdog();
  try {
    await postIssue(workerUrl, issueUrl, webhookUrl, debug);
    process.stderr.write(`posted to ${workerUrl}/issue\n\n`);
  } catch (err) {
    process.stderr.write(`POST /issue failed: ${err?.message ?? err}\n`);
    exit(4);
  }
});

// ── Webhook handler ────────────────────────────────────────────────

function handleWebhook(payload) {
  if (payload?.type === "debug") {
    printDebug(payload);
    return;
  }
  const message = typeof payload?.message === "string" ? payload.message : "";
  if (message) printMessage(message);

  if (payload && typeof payload.commit === "object" && payload.commit) {
    printCommit(payload.commit);
  }
  if (typeof payload?.patch === "string" && payload.patch.length > 0) {
    printPatch(payload.patch);
  }

  if (message.trimEnd().endsWith("DONE")) {
    clearTimeout(watchdog);
    server.close(() => exit(0));
  }
}

function printDebug(payload) {
  const stamp = new Date().toISOString().slice(11, 19);
  const phase = payload.phase ? `:${payload.phase}` : "";
  if (payload.kind === "tool-call") {
    const status = payload.success ? "ok" : "err";
    const detail = payload.success
      ? JSON.stringify(payload.output ?? null).slice(0, 200)
      : `error=${String(payload.error).slice(0, 200)}`;
    process.stdout.write(
      `${dim(`[${stamp} debug${phase}]`)} ${bold(payload.tool)} → ${status} ${dim(`(${payload.durationMs}ms)`)} ${detail}\n`,
    );
    return;
  }
  if (payload.kind === "assistant-text") {
    const text = typeof payload.text === "string" ? payload.text : "";
    process.stdout.write(
      `${dim(`[${stamp} debug${phase}]`)} ${italic("assistant")}: ${text.slice(0, 400)}\n`,
    );
    return;
  }
  process.stdout.write(
    `${dim(`[${stamp} debug${phase}]`)} ${JSON.stringify(payload).slice(0, 400)}\n`,
  );
}

function printMessage(message) {
  const stamp = new Date().toISOString().slice(11, 19);
  process.stdout.write(`[${stamp}] ${message}\n`);
}

function printCommit(commit) {
  const subject = typeof commit.subject === "string" ? commit.subject : "";
  const body = typeof commit.body === "string" ? commit.body : "";
  process.stdout.write(`\n${bold("Commit:")} ${subject}\n`);
  if (body) process.stdout.write(`${body}\n`);
}

function printPatch(patch) {
  process.stdout.write(`\n${bold("Patch:")}\n`);
  for (const line of patch.split("\n")) {
    process.stdout.write(`${colourDiffLine(line)}\n`);
  }
}

// ── Output helpers ─────────────────────────────────────────────────

const USE_COLOUR = process.stdout.isTTY && !env.NO_COLOR;
function ansi(open, close, s) {
  return USE_COLOUR ? `\x1b[${open}m${s}\x1b[${close}m` : s;
}
function bold(s) {
  return ansi("1", "22", s);
}
function green(s) {
  return ansi("32", "39", s);
}
function red(s) {
  return ansi("31", "39", s);
}
function cyan(s) {
  return ansi("36", "39", s);
}
function dim(s) {
  return ansi("2", "22", s);
}
function italic(s) {
  return ansi("3", "23", s);
}

function colourDiffLine(line) {
  if (line.startsWith("@@")) return cyan(line);
  if (line.startsWith("+++") || line.startsWith("---")) return bold(line);
  if (line.startsWith("+")) return green(line);
  if (line.startsWith("-")) return red(line);
  if (line.startsWith("diff ") || line.startsWith("index ")) return dim(line);
  return line;
}

// ── HTTP / argv helpers ────────────────────────────────────────────

async function postIssue(workerUrl, issueUrl, webhookUrl, debug) {
  const res = await fetch(`${workerUrl}/issue`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ issue_url: issueUrl, webhook_url: webhookUrl, debug }),
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
  }
  return res.json();
}

function parseArgs(args) {
  let issueUrl;
  let workerUrl = env.TRIAGE_WORKER ?? "http://127.0.0.1:8787";
  let advertiseHost = env.TRIAGE_HOST ?? "";
  let debug = env.TRIAGE_DEBUG === "1" || env.TRIAGE_DEBUG === "true";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--worker") {
      workerUrl = args[++i] ?? workerUrl;
      continue;
    }
    if (a === "--host") {
      advertiseHost = args[++i] ?? advertiseHost;
      continue;
    }
    if (a === "--debug") {
      debug = true;
      continue;
    }
    if (!issueUrl) issueUrl = a;
  }
  return { issueUrl, workerUrl: workerUrl.replace(/\/+$/, ""), advertiseHost, debug };
}

function pickHost() {
  const ifs = os.networkInterfaces();
  for (const list of Object.values(ifs)) {
    if (!list) continue;
    for (const ent of list) {
      if (ent.family === "IPv4" && !ent.internal) return ent.address;
    }
  }
  // Last resort. On macOS / Linux dev hosts this is usually wrong
  // for containerised callers — that's why we accept --host.
  return "127.0.0.1";
}
