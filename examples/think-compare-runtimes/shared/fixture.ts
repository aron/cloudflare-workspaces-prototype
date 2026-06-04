export interface FixtureFile {
  path: string;
  contents: string;
}

export interface ComparisonFixture {
  root: string;
  task: string;
  files: FixtureFile[];
}

export const comparisonFixture: ComparisonFixture = {
  root: "/workspace/repo",
  task: [
    "Fix the request policy helper so the tests pass.",
    "The helper should allow safe GET and HEAD requests, block mutating methods unless an explicit bypass token is present, preserve the existing public API, and return a short reason string for denied requests.",
    "Make the smallest clear change and summarize how you verified it.",
  ].join(" "),
  files: [
    {
      path: "package.json",
      contents: `${JSON.stringify(
        {
          scripts: {
            test: "vitest run",
          },
          dependencies: {},
          devDependencies: {
            typescript: "^6.0.3",
            vitest: "^4.1.7",
          },
        },
        null,
        2,
      )}\n`,
    },
    {
      path: "README.md",
      contents: `# Request policy helper\n\nThis small package evaluates incoming Worker requests before they reach a mutating handler.\n\nSafe HTTP methods should pass without a token. Mutating methods require the configured bypass token. Denied requests should include a short reason that callers can log.\n`,
    },
    {
      path: "src/request-policy.ts",
      contents: `export interface RequestPolicyOptions {\n  bypassToken?: string;\n}\n\nexport interface RequestPolicyDecision {\n  allowed: boolean;\n  reason?: string;\n}\n\nconst SAFE_METHODS = new Set(["GET"]);\n\nexport function evaluateRequestPolicy(\n  request: Request,\n  options: RequestPolicyOptions = {},\n): RequestPolicyDecision {\n  if (SAFE_METHODS.has(request.method)) {\n    return { allowed: true };\n  }\n\n  const token = request.headers.get("x-bypass-token");\n  if (token && token === options.bypassToken) {\n    return { allowed: true };\n  }\n\n  return { allowed: false };\n}\n`,
    },
    {
      path: "src/request-policy.test.ts",
      contents: `import { describe, expect, test } from "vitest";\nimport { evaluateRequestPolicy } from "./request-policy";\n\ndescribe("evaluateRequestPolicy", () => {\n  test("allows safe methods", () => {\n    expect(evaluateRequestPolicy(new Request("https://example.com/report", { method: "GET" }))).toEqual({\n      allowed: true,\n    });\n    expect(evaluateRequestPolicy(new Request("https://example.com/report", { method: "HEAD" }))).toEqual({\n      allowed: true,\n    });\n  });\n\n  test("blocks mutating requests without the bypass token", () => {\n    expect(\n      evaluateRequestPolicy(new Request("https://example.com/report", { method: "POST" }), {\n        bypassToken: "enterprise-export",\n      }),\n    ).toEqual({ allowed: false, reason: "mutating method requires bypass token" });\n  });\n\n  test("allows mutating requests with the bypass token", () => {\n    const request = new Request("https://example.com/report", {\n      method: "DELETE",\n      headers: { "x-bypass-token": "enterprise-export" },\n    });\n\n    expect(evaluateRequestPolicy(request, { bypassToken: "enterprise-export" })).toEqual({\n      allowed: true,\n    });\n  });\n\n  test("rejects mismatched bypass tokens", () => {\n    const request = new Request("https://example.com/report", {\n      method: "PATCH",\n      headers: { "x-bypass-token": "wrong" },\n    });\n\n    expect(evaluateRequestPolicy(request, { bypassToken: "enterprise-export" })).toEqual({\n      allowed: false,\n      reason: "mutating method requires bypass token",\n    });\n  });\n});\n`,
    },
  ],
};
