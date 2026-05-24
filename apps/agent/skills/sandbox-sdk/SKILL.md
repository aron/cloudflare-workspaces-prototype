---
name: sandbox-sdk
description: Cloudflare Sandbox SDK patterns. Use when running untrusted code, building AI code execution, code interpreters, CI-style runners, or interactive dev environments backed by Cloudflare Containers.
---

# Cloudflare Sandbox SDK

The Sandbox SDK (`@cloudflare/sandbox`) wraps a Cloudflare Container with a typed RPC surface for running arbitrary commands, managing files, and exposing preview URLs. It's the right tool when:

- You need to execute model-generated code safely.
- You want a per-session Linux box reachable from a Worker.
- You're building a code interpreter, REPL, build runner, or sandboxed CI.

## Bindings

```jsonc
// wrangler.jsonc
{
  "containers": [
    {
      "class_name": "Sandbox",
      "image": "./Dockerfile",
      "instance_type": "lite",
      "max_instances": 10
    }
  ],
  "durable_objects": {
    "bindings": [{ "class_name": "Sandbox", "name": "Sandbox" }]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["Sandbox"] }
  ]
}
```

`Sandbox` is exported by `@cloudflare/sandbox` and is itself a Durable Object class. `getSandbox(env.Sandbox, id)` returns an RPC stub.

## RPC surface

- `sb.exec(command, { cwd?, env? })` → `{ exitCode, stdout, stderr }`
- `sb.writeFile(path, content)` / `sb.readFile(path)`
- `sb.process.start(command)` → background process you can stream from
- `sb.exposePort(port)` → public preview URL

## Lifecycle

Containers cold-start in the low seconds. Pair the binding with a warm pool (one DO per host that pre-creates containers and hands them out) to keep p50 fast.

## Common patterns

**Run model-generated code:**
```ts
const sb = getSandbox(env.Sandbox, sessionId);
await sb.writeFile("/tmp/program.py", code);
const result = await sb.exec("python /tmp/program.py");
return Response.json(result);
```

**Build → load workflow** (this app's `worker_deploy` tool):
1. Push the source tree to the container's filesystem.
2. `sb.exec("wrangler deploy --dry-run", { cwd: "/workspace" })`.
3. Read the produced bundle back out.
4. Load it into a Dynamic Worker via `@cloudflare/workspace/worker-sandbox`.

## Reference

```
gh repo clone cloudflare/sandbox-sdk /repos/sandbox-sdk
```

The `/repos/sandbox-sdk/examples/` directory has end-to-end recipes.
