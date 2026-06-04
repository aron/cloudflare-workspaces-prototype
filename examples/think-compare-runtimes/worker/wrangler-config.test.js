import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

describe("wrangler config", () => {
  test("enables Sandbox SDK RPC transport through Worker vars", () => {
    const config = readWranglerConfig();

    expect(config.vars).toMatchObject({ SANDBOX_TRANSPORT: "rpc" });
  });
});

function readWranglerConfig() {
  const raw = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  return JSON.parse(stripJsonComments(raw));
}

function stripJsonComments(input) {
  return input.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/(^|\s)\/\/.*$/gm, "$1");
}
