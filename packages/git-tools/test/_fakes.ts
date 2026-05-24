/**
 * Shared fakes for git-tools tests.
 *
 * The upstream `ArtifactsBinding` interface gained fields over time (id,
 * description, tokenExpiresAt, total, etc.). Rather than re-spelling the
 * stub shape in every test, this module centralises the placeholder values
 * so additions only need to land in one place.
 */

import { vi } from "vitest";
import type { ArtifactsBinding } from "@cloudflare/workspace/git";

/** Fields the fakes don't care about but the published types require. */
const REPO_META = {
  id:             "fake-id",
  description:    null,
  createdAt:      "2099-01-01T00:00:00Z",
  updatedAt:      "2099-01-01T00:00:00Z",
  lastPushAt:     null,
  source:         null,
  readOnly:       false,
  tokenExpiresAt: "2099-01-01T00:00:00Z",
} as const;

export interface ArtifactsCallLog {
  import: unknown[];
  get:    string[];
  create: string[];
}

/**
 * Default fake binding: import() returns a synthetic repo, get() throws.
 * Suitable for tests that only need import() to succeed (clone path).
 */
export function fakeArtifacts(): { binding: ArtifactsBinding; calls: ArtifactsCallLog } {
  const calls: ArtifactsCallLog = { import: [], get: [], create: [] };
  const binding: ArtifactsBinding = {
    async create(name) {
      calls.create.push(name);
      throw new Error("unused");
    },
    async get(name) {
      calls.get.push(name);
      throw new Error("fake: not found");
    },
    async list() {
      return { repos: [], total: 0 };
    },
    async import(params) {
      calls.import.push(params);
      return {
        ...REPO_META,
        name:          params.target.name,
        remote:        "https://fake.artifacts.dev/git/default/x.git",
        defaultBranch: "main",
        token:         "art_v1_x?expires=9999999999",
      };
    },
    async delete() {
      return true;
    },
  };
  return { binding, calls };
}

/** Bare-bones binding for tests that exercise upstream error paths only. */
export function unusedArtifacts(): ArtifactsBinding {
  return {
    async create() { throw new Error("unused"); },
    async get()    { throw new Error("fake: not found"); },
    async list()   { return { repos: [], total: 0 }; },
    async import() { throw new Error("unused"); },
    async delete() { return true; },
  };
}

/** Minimal Vfs-like stub. */
export function fakeVfs() {
  return {
    stat:           vi.fn().mockReturnValue(null),
    readFile:       vi.fn().mockReturnValue(null),
    writeFile:      vi.fn(),
    mkdir:          vi.fn(),
    deleteFile:     vi.fn(),
    readdir:        vi.fn().mockReturnValue([]),
    listFilesUnder: vi.fn().mockReturnValue([]),
  };
}

export function fakeWorkspace(opts: { withRegistry?: boolean } = {}) {
  const registry = opts.withRegistry
    ? {
        get:    vi.fn().mockReturnValue(null),
        upsert: vi.fn(),
        delete: vi.fn(),
      }
    : undefined;
  return {
    sessionId:    "test-session",
    vfs:          fakeVfs() as unknown as import("@cloudflare/workspace").Vfs,
    mkdir:        vi.fn(async () => {}),
    forkRegistry: registry,
  };
}

/** Builder for the `create-repo` happy-path assertion. */
export function makeCreateResult(name: string, description: string | null = null) {
  return {
    ...REPO_META,
    name,
    remote:        `https://fake.artifacts.dev/git/default/${name}.git`,
    defaultBranch: "main",
    token:         `art_v1_${name}?expires=9999999999`,
    description,
  };
}
