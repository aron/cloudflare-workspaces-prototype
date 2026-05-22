/**
 * worker.fetch implementation.
 *
 * The model passes a single string that looks like a JavaScript fetch() call:
 *
 *   fetch("https://w/api/users", { method: "POST", body: "...", headers: {...} })
 *
 * We parse it with acorn (no eval, no execution of arbitrary code) and accept
 * only static literals — strings, numbers, booleans, plain object literals and
 * arrays. Anything dynamic (variables, function calls, computed property names,
 * spreads) is rejected with a clear error.
 *
 * The resulting fetch is dispatched against the currently-deployed Dynamic
 * Worker. The response is serialised into a curl-style JSON object: status,
 * headers, body (omitted when binary). Body is truncated past BODY_LIMIT.
 */

import { Parser } from "acorn";
import type { LoadedWorker } from "@cloudflare/workspace/worker-sandbox";

const BODY_LIMIT = 64 * 1024;

export interface FetchToolResult {
  status:        number;
  statusText:    string;
  headers:       Record<string, string>;
  body?:         string;
  bodyOmitted?:  boolean;
  bodyTruncated?: boolean;
  bodySize:      number;
  bodyMime?:     string;
  durationMs:    number;
}

export interface ParsedFetch {
  url:    string;
  method: string;
  headers: Record<string, string>;
  body?:  string;
}

export function parseFetchCall(src: string): ParsedFetch {
  const ast: any = Parser.parse(src.trim(), { ecmaVersion: 2022, sourceType: "module" });

  if (ast.body.length !== 1 || ast.body[0].type !== "ExpressionStatement") {
    throw new Error("expected a single fetch(...) expression");
  }
  const call = ast.body[0].expression;
  if (call.type !== "CallExpression" || call.callee.type !== "Identifier" || call.callee.name !== "fetch") {
    throw new Error("expected a call to fetch(...)");
  }
  if (call.arguments.length < 1 || call.arguments.length > 2) {
    throw new Error("fetch() takes 1 or 2 arguments");
  }

  const url = staticString(call.arguments[0], "url");

  let method = "GET";
  let headers: Record<string, string> = {};
  let body: string | undefined;

  if (call.arguments[1]) {
    const init = staticObject(call.arguments[1], "init");
    if ("method" in init) {
      if (typeof init.method !== "string") throw new Error("init.method must be a string");
      method = init.method.toUpperCase();
    }
    if ("headers" in init) {
      const h = init.headers;
      if (typeof h !== "object" || h === null || Array.isArray(h)) {
        throw new Error("init.headers must be a plain object");
      }
      for (const [k, v] of Object.entries(h)) {
        if (typeof v !== "string") throw new Error(`headers.${k} must be a string`);
        headers[k] = v;
      }
    }
    if ("body" in init) {
      if (typeof init.body !== "string") throw new Error("init.body must be a string (stringify objects yourself)");
      body = init.body;
    }
  }

  return { url, method, headers, body };
}

function staticString(node: any, what: string): string {
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0 && node.quasis.length === 1) {
    return node.quasis[0].value.cooked;
  }
  throw new Error(`${what} must be a static string`);
}

function staticValue(node: any, path: string): unknown {
  switch (node.type) {
    case "Literal":              return node.value;
    case "TemplateLiteral":
      if (node.expressions.length === 0 && node.quasis.length === 1) return node.quasis[0].value.cooked;
      throw new Error(`${path}: template literal with interpolation`);
    case "Identifier":
      if (node.name === "undefined") return undefined;
      throw new Error(`${path}: unsupported identifier '${node.name}'`);
    case "UnaryExpression":
      if (node.operator === "-" && node.argument.type === "Literal" && typeof node.argument.value === "number") {
        return -node.argument.value;
      }
      throw new Error(`${path}: unsupported unary operator '${node.operator}'`);
    case "ArrayExpression":
      return node.elements.map((el: any, i: number) => {
        if (el === null) throw new Error(`${path}[${i}]: sparse array slot`);
        return staticValue(el, `${path}[${i}]`);
      });
    case "ObjectExpression":
      return staticObject(node, path);
    default:
      throw new Error(`${path}: unsupported node ${node.type}`);
  }
}

function staticObject(node: any, path: string): Record<string, unknown> {
  if (node.type !== "ObjectExpression") {
    throw new Error(`${path} must be an object literal`);
  }
  const out: Record<string, unknown> = {};
  for (const prop of node.properties) {
    if (prop.type !== "Property" || prop.computed || prop.kind !== "init") {
      throw new Error(`${path}: unsupported property kind`);
    }
    const key = prop.key.type === "Identifier" ? prop.key.name
              : prop.key.type === "Literal"    ? String(prop.key.value)
              : null;
    if (key === null) throw new Error(`${path}: unsupported key`);
    out[key] = staticValue(prop.value, `${path}.${key}`);
  }
  return out;
}

// ---- dispatch ----

const TEXT_LIKE_MIME = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|graphql)|image\/svg\+xml)/i;

export async function fetchAgainstWorker(
  worker: LoadedWorker,
  parsed: ParsedFetch,
): Promise<FetchToolResult> {
  const t0 = Date.now();

  const noBody = parsed.method === "GET" || parsed.method === "HEAD";
  const request = new Request(parsed.url, {
    method:  parsed.method,
    headers: parsed.headers,
    body:    noBody ? undefined : parsed.body,
  });
  const res = await worker.fetch(request);

  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { headers[k] = v; });
  const bodyMime = res.headers.get("content-type") ?? undefined;

  const rawBytes = new Uint8Array(await res.arrayBuffer());
  const isTextLike = bodyMime ? TEXT_LIKE_MIME.test(bodyMime) : looksLikeText(rawBytes);

  const out: FetchToolResult = {
    status:     res.status,
    statusText: res.statusText,
    headers,
    bodySize:   rawBytes.length,
    bodyMime,
    durationMs: Date.now() - t0,
  };

  if (!isTextLike) {
    out.bodyOmitted = true;
    return out;
  }

  // Truncate if huge.
  const truncated = rawBytes.length > BODY_LIMIT ? rawBytes.subarray(0, BODY_LIMIT) : rawBytes;
  out.body = new TextDecoder("utf-8", { fatal: false }).decode(truncated);
  if (truncated !== rawBytes) out.bodyTruncated = true;
  return out;
}

function looksLikeText(buf: Uint8Array): boolean {
  // Heuristic: < 16KB and all bytes printable / common whitespace.
  if (buf.length === 0) return true;
  const sample = buf.length <= 4096 ? buf : buf.subarray(0, 4096);
  let printable = 0;
  for (const b of sample) {
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127)) printable++;
    else if (b >= 0x80) printable++;  // assume UTF-8 continuation
  }
  return printable / sample.length > 0.85;
}
