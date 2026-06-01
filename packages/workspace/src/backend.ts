// A backend produces a connection to a running wsd instance.
//
// The Workspace constructor takes a list of backends and tries
// each one's connect() in order until one succeeds. Backends are
// the seam where "where does wsd live" is decided: a Cloudflare
// container DO, a remote sandbox via the bridge, or, for tests,
// an already-running wsd at a known URL.
//
// Backends do not own wsd's lifecycle beyond the handle they
// hand back. close() on the BackendHandle tears down whatever
// the backend created on connect() (the SyncRPC stub, the
// container, etc.); a backend that doesn't own a container
// (TestBackend) only closes the stub.
//
// The interface stays narrow on purpose. Anything wsd-specific
// (sync, exec, ...) sits on the returned rpc stub. Backends do
// not see method signatures; they only produce URLs and tear
// them down.

import type { WorkspaceRPC } from "@cloudflare/workspace-rpc";

export interface WorkspaceBackend {
  // Stable identifier for diagnostics. Conventions:
  //   "test"
  //   "cloudflare-container"
  readonly id: string;

  // Materialise a wsd connection. Throws if the backend isn't
  // reachable; the Workspace catches and falls through to the
  // next backend.
  connect(): Promise<BackendHandle>;
}

export interface BackendHandle {
  // The composite WorkspaceRPC stub pointing at the wsd
  // backend produced.
  rpc: WorkspaceRPC;
  // Tear down the connection. Idempotent. The Workspace calls
  // close() during its own close(); backend authors don't need
  // to handle re-entry.
  close(): Promise<void>;
}
