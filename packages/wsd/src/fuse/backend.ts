import { access as defaultAccess } from "node:fs/promises";

export type FUSEBackend =
  | { kind: "linux" }
  | { kind: "fuse-t"; dylibDir: string }
  | { kind: "macfuse" }
  | { kind: "none"; reason: string };

export interface DetectFUSEBackendOptions {
  access?: (path: string) => Promise<void>;
  arch?: NodeJS.Architecture;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

const LINUX_FUSE_DEVICE = "/dev/fuse";
const FUSE_T_FILESYSTEM = "/Library/Filesystems/fuse-t.fs";
const MACFUSE_FILESYSTEM = "/Library/Filesystems/macfuse.fs";
const HOMEBREW_ARM64_LIB = "/opt/homebrew/lib";
const HOMEBREW_INTEL_LIB = "/usr/local/lib";

export async function detectFUSEBackend(options: DetectFUSEBackendOptions = {}): Promise<FUSEBackend> {
  const access = options.access ?? defaultAccess;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const env = options.env ?? process.env;
  const requested = env.WSD_FUSE_BACKEND ?? "auto";

  if (!isValidBackendPreference(requested)) {
    return { kind: "none", reason: `invalid WSD_FUSE_BACKEND=${JSON.stringify(requested)}` };
  }

  if (platform === "linux") {
    if (requested !== "auto" && requested !== "linux") {
      return { kind: "none", reason: `WSD_FUSE_BACKEND=${requested} is not supported on linux` };
    }

    return await canAccess(access, LINUX_FUSE_DEVICE)
      ? { kind: "linux" }
      : { kind: "none", reason: "FUSE is unavailable because /dev/fuse is not accessible" };
  }

  if (platform === "darwin") {
    if (requested === "linux") {
      return { kind: "none", reason: "WSD_FUSE_BACKEND=linux is not supported on macOS" };
    }

    if (requested === "auto" || requested === "fuse-t") {
      if (await canAccess(access, FUSE_T_FILESYSTEM)) {
        return { kind: "fuse-t", dylibDir: await resolveFUSETDylibDir(access, arch) };
      }

      if (requested === "fuse-t") {
        return { kind: "none", reason: "FUSE-T is unavailable; install fuse-t or use WSD_FUSE_BACKEND=auto" };
      }
    }

    if (requested === "auto" || requested === "macfuse") {
      if (await canAccess(access, MACFUSE_FILESYSTEM)) {
        return { kind: "macfuse" };
      }

      if (requested === "macfuse") {
        return { kind: "none", reason: "macFUSE is unavailable; install macFUSE or use WSD_FUSE_BACKEND=auto" };
      }
    }

    return { kind: "none", reason: "install FUSE-T (recommended) or macFUSE" };
  }

  return { kind: "none", reason: `unsupported platform ${platform}` };
}

async function resolveFUSETDylibDir(
  access: (path: string) => Promise<void>,
  arch: NodeJS.Architecture,
): Promise<string> {
  const preferred = arch === "arm64" ? HOMEBREW_ARM64_LIB : HOMEBREW_INTEL_LIB;
  const fallback = arch === "arm64" ? HOMEBREW_INTEL_LIB : HOMEBREW_ARM64_LIB;

  if (await canAccess(access, preferred)) {
    return preferred;
  }
  if (await canAccess(access, fallback)) {
    return fallback;
  }

  return preferred;
}

async function canAccess(access: (path: string) => Promise<void>, path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isValidBackendPreference(value: string): value is "auto" | "linux" | "fuse-t" | "macfuse" {
  return value === "auto" || value === "linux" || value === "fuse-t" || value === "macfuse";
}
