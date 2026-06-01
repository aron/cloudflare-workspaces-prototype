# Audit: docs/07_injected_service.md

## Scope

`docs/07_injected_service.md` describes the "injected service" — the
workspace-server process that runs inside the sandbox container, owns
the FUSE mount, and exposes capnweb RPC to the DO. The doc covers
responsibilities (FUSE, dirty tracking, exec, apply, health),
installation via a `cloudflare/workspace` Docker image + `ws.js`
artifact, a provider-agnostic boot sequence (start → poll `/healthz`
→ open `/rpc`), Cloudflare Containers specifics
(`startProcess("node /app/ws.js", …)`, `containerFetch`), env vars
(`PORT=4567`, `MOUNT_POINT=/workspace`, `LOG_FILE=/tmp/server.log`),
a failure model (`uncaughtException` → `LOG_FILE` → `exit(1)`,
FUSE-refusal degrades to `fuseActive=false`), and a lifetime
discussion. The header itself warns that the doc has diverged from
`main`.

## Methodology

Inspected (read-only) against tip of tree:

- `packages/wsd/package.json`, `README.md`, `scripts/build-bin.mjs`.
- `packages/wsd/src/cli/wsd.ts` (entrypoint, env parsing, HTTP routes,
  shutdown).
- `packages/wsd/src/fuse/` (backend detection, mount, driver) at a
  surface level.
- `packages/workspace/src/backends/cloudflare-container.ts`
  (lifecycle / wiring on the host side).
- `packages/workspace/src/workspace.ts` (boot hooks).
- `examples/wsd-container/Dockerfile` (the real shipped recipe).
- `grep` for `LOG_FILE`, `uncaughtException`, `unhandledRejection`,
  `fuseActive`, `workspace-server`, `/healthz`, `/rpc`,
  `getProcess`, `startProcess`, `containerFetch` across `packages/`.

Every normative claim in the doc was mapped to a symbol (or absence of
one) below.

## Findings

| # | Claim (doc line) | Status | Evidence | Notes | Tag |
| - | --- | --- | --- | --- | --- |
| 1 | "Single pre-built script — `ws.js` — that you copy into your container image" (L15) | ❌ | The artifact is a binary named `wsd`. Package `@cloudflare/workspace-wsd`, bin `"wsd": "./dist/cli/wsd.cjs"` (`packages/wsd/package.json:2,9`). `scripts/build-bin.mjs` produces standalone SEA binaries at `artifacts/wsd/wsd-linux-x64` / `wsd-macos-x64`. No `ws.js` artifact exists in tree. | – | doc-fix; also `needs-decision` if we want to rename for marketing parity |
| 2 | "Needs a Node.js runtime present in the image to execute … future versions will look at packaging it as a self-contained binary" (L16-18) | ❌ | The self-contained binary already exists — `build:bin` produces a Node SEA binary with `fuse-native` prebuilds and `libfuse` embedded as SEA assets (`packages/wsd/scripts/build-bin.mjs:38-115`). The example Dockerfile copies the binary directly and does not install Node (`examples/wsd-container/Dockerfile:21-22`). | The roadmap item is already shipped. | doc-fix |
| 3 | FUSE responsibility — mounts the VFS at `MOUNT_POINT` (L22-25) | ✅ | `mountFuse({ backend, mountPoint, vfs })` called from `wsd.ts:330-334` after `mkdir(mountPoint, { recursive: true })`. `DEFAULT_MOUNT_POINT = "/workspace"` (`wsd.ts:24`). | – | – |
| 4 | Dirty tracking via FUSE writes → mirror revisions, served by pull RPCs (L26-28) | ⚠️ | Sync surface exists (`UPSTREAM_URL` → `createSyncClient`, `wsd.ts:319-323`) and the FUSE driver writes through the VFS DB, but the doc's specific framing (container-side rev numbers, "pull RPCs serve those revisions") needs to be verified against `workspace-rpc` and `fuse/vfs.ts`. The high-level claim is plausibly true; the wording is asymmetric with how sync actually flows. | Re-check against doc 02 / 08 once those are audited. | doc-fix |
| 5 | Exec responsibility — runs shell commands, streams over capnweb (L29-30) | ✅ | `Runner` constructed in `wsd.ts:339-344`, wired into `createWorkspaceServer(db, runner)` (`wsd.ts:345`). | – | – |
| 6 | Apply responsibility — accepts pushed changes, suppresses own dirty-tracking (L31-33) | ⚠️ | Apply path lives in `workspace-rpc`/`workspace-fs` Database; not visibly exercised in `wsd.ts` beyond exposing the server. Suppression behaviour is a sync-protocol claim covered better by docs 02/04 audits. | Out of strict scope here; flag as cross-doc. | – |
| 7 | "Small HTTP health endpoint so the host-side workspace can poll for readiness" (L34-35) | ✅ | `GET /health` returns `200 ok\n` (`wsd.ts:134-140`). | But the endpoint is `/health`, not `/healthz` — see #11. | – |
| 8 | Dockerfile recipe: `FROM cloudflare/workspace:latest AS workspace` + `COPY --from=workspace /app/ws.js ./ws.js` (L42-54) | ❌ | No published `cloudflare/workspace` image exists. The shipped recipe (`examples/wsd-container/Dockerfile`) starts `FROM debian:stable-slim`, installs `fuse3 libfuse2t64`, copies a locally-built `build/wsd-linux-x64` binary, and runs it as `ENTRYPOINT ["/usr/local/bin/wsd"]`. No Node, no `npm install`, no `ws.js`. | The whole "multi-stage off published image" story is fiction today. | doc-fix; `needs-decision` whether we want to publish such an image |
| 9 | Runtime requirements: "A Node.js runtime on `PATH` (the script is executed via `node /app/ws.js`)" (L63) | ❌ | The SEA binary embeds Node; no host Node is required. The example Dockerfile installs no Node. | – | doc-fix |
| 10 | Runtime requirements: `fuse3` and `libfuse2` (L64) | ⚠️ | Example Dockerfile installs `fuse3 libfuse2t64` (the t64 ABI variant on current Debian, not `libfuse2`). `libfuse` itself is embedded into the SEA binary as an asset (`build-bin.mjs:43,57`), so the apt install is mainly for `/dev/fuse` userland tooling and the kernel module path. | Detail correction. | doc-fix |
| 11 | `EXPOSE 4567` (L58) and "workspace-server port (default 4567)" (L77) | ❌ | `DEFAULT_PORT = 45678` (`wsd.ts:23`); README repeats `45678` (`packages/wsd/README.md:10`); example Dockerfile picks `8080` and `EXPOSE 8080` (`Dockerfile:28-30`). 4567 appears nowhere in code. | One-digit drift vs DEFAULT; the example overrides it again. | doc-fix; `needs-decision`: which port do we actually want as the canonical default? |
| 12 | Boot step 2: "Poll `GET /healthz` on the workspace-server port" (L76-79) | ❌ | Endpoint is `/health`, not `/healthz` (`wsd.ts:134`). | – | doc-fix |
| 13 | "The FUSE mount and RPC listener are both up by the time `/healthz` returns OK" (L78-79) | ❌ | `/health` is wired by `createServer` and is `200` as soon as the HTTP server binds (`wsd.ts:134-140, 382`); the FUSE mount is awaited *before* `listen` (`wsd.ts:330-334`), so in the FUSE-enabled path the claim happens to hold. But with `DISABLE_FUSE=1` (the Cloudflare container backend's default — see #18) no FUSE mount is involved at all, and `wsd`'s README explicitly notes "it does not currently block on FUSE readiness." | The "readiness signal" framing oversells what `/health` guarantees. | doc-fix |
| 14 | Boot step 3: host issues "WebSocket upgrade to `/rpc` (same port)" (L80-82) | ❌ | The capnweb WebSocket endpoint is `/ws`, not `/rpc` (`wsd.ts:170, 175-177`). `/api` is the HTTP-batch alternative (`wsd.ts:90-107`). Stale `/rpc` reference also lives in `packages/workspace-rpc/src/client.ts:18` as a comment, which should be cleaned up too. | – | doc-fix (+ small code-fix to the stale comment in workspace-rpc client) |
| 15 | "Host bootstraps a capnweb session against the server's `ContainerRPC` stub" (L81-82) | ⚠️ | The RPC interface is `WorkspaceRPC` (`packages/workspace-rpc/src/interface.ts`, imported in `cloudflare-container.ts:42` as `WorkspaceRPC`), not `ContainerRPC`. | Naming drift. | doc-fix |
| 16 | Cloudflare specifics — "looks for an existing `workspace-server` process via `getProcess()`. If a `running` or `starting` record exists it's reused; otherwise `startProcess("node /app/ws.js", { processId: "workspace-server" })`" (L92-95) | ❌ | `CloudflareContainerBackend.#ensureContainerStarted` uses `container.start({ enableInternet, env })` (`cloudflare-container.ts:204-214`) — the Cloudflare Containers API, not the `@cloudflare/sandbox` SDK's `startProcess`/`getProcess`. There is no `processId`, no `node /app/ws.js` command (the container's `ENTRYPOINT` runs `wsd` directly), and no reuse-by-process-name logic. Idempotence comes from `container.running` and the cached `#handle`. | This is the largest single drift. The doc describes a previous (sandbox-SDK based) design that has been replaced. | doc-fix |
| 17 | Cloudflare specifics — "`containerFetch(req, port)` against the workspace-server port acts as the health probe" / "WS-upgrade `containerFetch` opens the WebSocket" (L96-100) | ❌ | Health probe is `container.getTcpPort(containerPort).fetch("http://container/health", { method: "HEAD" })` (`cloudflare-container.ts:234-246`). The WebSocket carrier is *inverted* relative to the doc: `wsd` dials *out* via its `POST /connect` endpoint (`wsd.ts:114-124, 212-260`), and the DO accepts the inbound upgrade in `handleFetch()` (`cloudflare-container.ts:160-184`). The egress is wired with `container.interceptOutboundHttp(egressHost, egress)` (`cloudflare-container.ts:230-232`). The doc's "host opens a WS upgrade into the container" mental model is the opposite of how connect() actually flows. | Major drift; this is a real behavioural difference, not just naming. | doc-fix |
| 18 | "Defends against … stale `failed` process records … See `src/container-startup.ts`" (L102-106) | ❌ | No file `packages/workspace/src/container-startup.ts` exists. The lifecycle code is in `backends/cloudflare-container.ts`, and its actual sharp edges are: `#armUpgrade` before `#postConnect` (because `wsd` can dial back before the POST returns), `#monitoring` flag that drops the cached handle on container exit, and the explicit "no transparent reconnect after mid-session drop — caller reconstructs the Workspace" note at the top of the file (`cloudflare-container.ts:34-40`). | – | doc-fix |
| 19 | Env var table: `PORT=4567` (L112) | ❌ | Default is `45678` (`wsd.ts:23`); Cloudflare container backend forces `PORT=8080` via container env (`cloudflare-container.ts:208-209`). | See #11. | doc-fix |
| 20 | Env var table: `MOUNT_POINT=/workspace` (L113) | ✅ | `DEFAULT_MOUNT_POINT = "/workspace"` (`wsd.ts:24`). Backend also sets `MOUNT_POINT=/workspace` for parity (`cloudflare-container.ts:210`). | – | – |
| 21 | Env var table: `LOG_FILE=/tmp/server.log` (L114) | ❌ | `LOG_FILE` is not consulted anywhere in `wsd` (`grep -rn LOG_FILE packages/wsd` → empty). `wsd` logs to stdout/stderr via `console.log` / `console.error` only (`wsd.ts:251, 255, 387-389, 399, 404`). | – | doc-fix |
| 22 | Env var table is exhaustive (table at L110-114) | ❌ | Code actually consumes: `PORT`, `MOUNT_POINT`, `DISABLE_FUSE`, `UPSTREAM_URL`, `EXEC_LOG_MAX_BYTES`, `WSD_FUSE_BACKEND` (`wsd.ts:305-322, 338`; `fuse/backend.ts:23`). The doc omits four of the six. | – | doc-fix |
| 23 | `uncaughtException` and `unhandledRejection` log to `LOG_FILE` and `process.exit(1)` (L118-120) | ❌ | No `process.on("uncaughtException"...)` / `unhandledRejection` handlers anywhere in `wsd` (grep is empty). The only `process.exit` paths are the top-level `main().catch` (`wsd.ts:403-406`) and the signal-based `shutdown()` (`wsd.ts:375`). | – | doc-fix; possibly `code-fix` if we *want* those handlers |
| 24 | "If FUSE refuses to mount, the server still starts but with `fuseActive=false`. Container-side writes are mirrored to the host filesystem" (L121-123) | ❌ | `wsd` does the opposite: if `DISABLE_FUSE` is not set and `detectFUSEBackend()` returns `{ kind: "none" }`, `main()` throws (`wsd.ts:315-317`). `DISABLE_FUSE=1` is the only graceful "skip FUSE" path. There is no `fuseActive` flag exposed anywhere, and there is no mirror-to-host-filesystem fallback — writes just stay in the in-memory VFS. | – | doc-fix |
| 25 | "Server outlives DO restarts … runs for the full container lifetime … every reconnect from the DO over the same in-memory VFS" (L127-130) | ⚠️ | `wsd` itself is a long-lived process; the container backend's `#monitoring` does drop the cached handle when the container exits (`cloudflare-container.ts:216-226`), so the "outlives DO restarts → reconnect" picture is consistent in spirit. But "same in-memory VFS" only holds while the container process is alive — there's "no on-disk persistence yet" per `packages/wsd/README.md:32`, so a container restart loses state (the sync loop is what brings it back when `UPSTREAM_URL` is set). The doc should be explicit about that. | – | doc-fix |
| 26 | Open questions section — connection auth, process user, FUSE ownership (L132-156) | ✅ | These are genuinely open and accurately characterised; the doc flags them as not-yet-specified. | Keep as-is. | – |
| 27 | Doc's own disclaimer that it has diverged from main (L3-9) | ✅ | True, and the divergence is large (see #1, #8, #11, #14, #16, #17, #21, #23, #24). | – | – |

## Drift summary

The doc is a sketch of a previous design where the container ran a
Node script (`ws.js`) under the `@cloudflare/sandbox` SDK's process
manager (`getProcess` / `startProcess`), and the host opened an
inbound WebSocket upgrade to `/rpc` on port 4567. None of that is
how the code works today.

What the code actually does:

- **Artifact.** A standalone Node SEA binary `wsd` (package
  `@cloudflare/workspace-wsd`), built by
  `packages/wsd/scripts/build-bin.mjs` into `artifacts/wsd/wsd-{linux,macos}-{x64}`.
  No `ws.js`, no Node-runtime requirement at the host, no published
  `cloudflare/workspace` Docker image.
- **Defaults.** `PORT=45678`, `MOUNT_POINT=/workspace`. The
  Cloudflare container backend overrides `PORT` to `8080` and forces
  `DISABLE_FUSE=1` (`cloudflare-container.ts:84, 208-212`) because
  Cloudflare Containers doesn't expose `/dev/fuse` yet.
- **Endpoints.** `GET /health` (not `/healthz`), `GET /ws`
  WebSocket (not `/rpc`), `POST /api` HTTP-batch capnweb, `POST
  /connect` for outbound WS-dial, `GET /__wsd/info`, `GET /`.
- **Cloudflare lifecycle.** `container.start({ env })` →
  `container.interceptOutboundHttp(egressHost, egress)` →
  `container.getTcpPort(port).fetch("/health", HEAD)` →
  `POST /connect` →  wsd dials the egress at
  `${egressHost}/ws` → the DO's `handleFetch()` accepts that
  upgrade and resolves the in-flight `#pendingUpgrade`. The
  WebSocket carrier is inverted versus the doc.
- **RPC name.** `WorkspaceRPC`, not `ContainerRPC`.
- **Env vars actually consumed.** `PORT`, `MOUNT_POINT`,
  `DISABLE_FUSE`, `UPSTREAM_URL`, `EXEC_LOG_MAX_BYTES`,
  `WSD_FUSE_BACKEND`. `LOG_FILE` is not consulted.
- **Logging.** `console.log` / `console.error` to stdout/stderr.
  No `LOG_FILE`, no `uncaughtException`/`unhandledRejection`
  handlers.
- **FUSE failure model.** If FUSE detection fails and `DISABLE_FUSE`
  is not set, `wsd` exits non-zero. There is no `fuseActive=false`
  degraded mode and no host-filesystem mirror fallback.

## Recommendations

Default tag is `doc-fix`. This doc needs a near-total rewrite to
reflect what shipped.

- doc-fix: rename `ws.js` → `wsd` throughout, and drop the
  "future: self-contained binary" aspiration in favour of pointing
  at the existing SEA build (`npm run build:bin --workspace
  @cloudflare/workspace-wsd`) and `examples/wsd-container/Dockerfile`
  as the canonical recipe.
- doc-fix: replace the Dockerfile example with the
  `examples/wsd-container/Dockerfile` shape (debian base + apt
  `fuse3 libfuse2t64` + `COPY build/wsd-linux-x64
  /usr/local/bin/wsd` + `ENTRYPOINT ["/usr/local/bin/wsd"]`).
- doc-fix: fix endpoint names — `/health` and `/ws`, plus mention
  `/api`, `/__wsd/info`, `/connect`. Fix the RPC name to
  `WorkspaceRPC`.
- doc-fix: rewrite the "Cloudflare Containers specifics" section to
  match `backends/cloudflare-container.ts` — `container.start` →
  `interceptOutboundHttp` → port probe via `getTcpPort().fetch` →
  `POST /connect` → outbound `/ws` dial → DO's `handleFetch`
  accepts. Drop the `getProcess`/`startProcess`/`containerFetch`
  vocabulary. Point at `cloudflare-container.ts` (not the
  nonexistent `container-startup.ts`).
- doc-fix: rebuild the env-var table to cover all six variables
  consumed by `wsd.ts` and `fuse/backend.ts`, and explicitly note
  that the Cloudflare backend pins `PORT=8080` and `DISABLE_FUSE=1`
  in `containerEnv`.
- doc-fix: replace the failure-handling section with what's actually
  there — no `LOG_FILE`, no uncaught handlers, FUSE detection
  failure is fatal unless `DISABLE_FUSE=1`. Either delete the
  `fuseActive=false`/host-fs-mirror story or move it to "open
  questions" as a design target.
- doc-fix: in the lifetime section, add the "no on-disk persistence
  yet — sync via `UPSTREAM_URL` is what brings state back across
  container restarts" caveat.
- code-fix (small): `packages/workspace-rpc/src/client.ts:18` has a
  stale comment referring to `ws://container-host:4567/rpc`. Bring
  it in line with `:45678/ws` (or whatever port we settle on).

## Needs-decision items

These are design questions the doc is implicitly asking, where I
don't think the audit can pick a side unilaterally:

- **`ws.js` vs `wsd` name.** The doc consistently uses `ws.js` as the
  contract name with the user. The code ships `wsd`. The doc name
  reads better in a Dockerfile (`COPY ws.js`) but doesn't match the
  package or the binary. Pick one and align both sides. Tag:
  `needs-decision`.
- **Default port: 4567 vs 45678 vs 8080.** The doc says 4567, the
  binary defaults to 45678, the Cloudflare backend forces 8080, the
  example Dockerfile `EXPOSE`s 8080. Three different numbers in one
  repo is the real bug. A canonical default in the binary (likely
  45678, since that's what `wsd` and its README already use) plus a
  one-line note in the Cloudflare specifics that the backend pins it
  to 8080 would resolve this. Tag: `needs-decision`.
- **Published `cloudflare/workspace` Docker image.** The doc promises
  one; none exists. Either ship one (so users get the "two-line
  Dockerfile" experience the doc pitches) or drop the promise and
  rely on `examples/wsd-container/` as the published recipe. The DX
  story in the doc is good; the question is whether we want to
  invest in the publishing pipeline. Tag: `needs-decision`.
- **`LOG_FILE` + uncaught-exception handler.** Worth keeping as a
  small `code-fix` if we agree that crashing to stderr only is not
  enough for a container daemon. The doc's behaviour
  (`LOG_FILE=/tmp/server.log`, `uncaughtException` →
  `process.exit(1)`) is a reasonable target. Tag: `needs-decision` /
  `code-fix`.
- **FUSE-refusal soft-fail (`fuseActive=false`).** Today FUSE
  failure is fatal. The doc's degraded-mode design (server still
  serves RPC, writes mirror to host filesystem) is more forgiving
  but adds a non-trivial code path (host-fs mirror). Worth deciding
  whether to demote to "open question" or actually build. Tag:
  `needs-decision`.

## Drifts where the doc target still looks valuable

- The published `cloudflare/workspace` image + one-liner Dockerfile
  story (#1, #8). The DX is genuinely nicer than "build the SEA
  binary yourself, then stage it." Keep as a roadmap item.
- The provider-agnostic boot sequence framing (#12, #14) — the
  three-step "start → poll health → open RPC" shape is still the
  right mental model even though the endpoint names and the WS
  direction need correcting.
- The `LOG_FILE` + structured failure-handling story (#21, #23).
  Stdout logging is fine for a CLI; for a daemon embedded in a
  Cloudflare Container, a dedicated log file + crash handler is a
  better default. Worth a small follow-up.
- The `fuseActive=false` degraded mode (#24) — useful for resilience
  if we want `wsd` to be honest about "RPC works, FUSE doesn't" in
  partial environments. Today `DISABLE_FUSE=1` covers the explicit
  case, but autodetected fallback would be friendlier.

Everything else under "Findings" is straightforwardly "doc has
drifted ahead of (or, mostly, *behind*) code; update the doc to
match what shipped."
