# basic-exec

The smallest possible example of `@cloudflare/workspace`: one Durable
Object that owns a `Workspace`, plus a Worker that forwards `POST /exec`
to it. The DO calls `workspace.exec(command, cwd)`, which spins up the
companion sandbox container on first use and runs the command there.

## Files

| File                | Purpose                                           |
|---------------------|---------------------------------------------------|
| `src/index.ts`      | `ExecAgent` DO + Worker `fetch()` handler         |
| `Dockerfile`        | Sandbox image with the workspace server bundled in|
| `wrangler.jsonc`    | DO bindings, container, migrations                |

## Run locally

`wrangler dev` builds the Dockerfile and starts the container under
Docker. Make sure `docker` is available on the host.

```bash
# from the repo root
npm install
npm run --workspace=@workspace-example/basic-exec dev
```

In another shell:

```bash
curl -X POST http://localhost:8787/exec \
     -H 'content-type: application/json' \
     -d '{"command":"uname -a && echo from-container"}'
# → {"exitCode":0,"stdout":"Linux ...\nfrom-container\n","stderr":""}

# Pick a different session — each name gets its own DO and its own
# container instance:
curl -X POST 'http://localhost:8787/exec?session=alice' \
     -H 'content-type: application/json' \
     -d '{"command":"echo hi from alice","cwd":"/tmp"}'
```

The first call to a given session has to cold-start the container (image
pull + boot + workspace server startup), so expect ~10s on the first
request and ~ms on subsequent ones.

## How the `/exec` endpoint relates to the in-container `/exec`

`packages/workspace/src/container-sandbox/server.ts` exposes its own
plain-HTTP `POST /exec` route inside the container with the same
`{command, cwd}` → `{exitCode, stdout, stderr}` wire format. This
example mirrors that route at the Worker boundary, but routes it
through `Workspace.exec()` so the VFS push/pull machinery runs as
normal (any files the command writes are pulled back into the DO's
SQLite VFS, any pending changes in the VFS are pushed before the
command runs).
