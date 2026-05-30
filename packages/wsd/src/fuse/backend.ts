import { access as defaultAccess } from "node:fs/promises";

export type FUSEBackend =
  | { kind: "linux" }
  | { kind: "macfuse" }
  | { kind: "none"; reason: string };

export interface DetectFUSEBackendOptions {
  access?: (path: string) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

const LINUX_FUSE_DEVICE = "/dev/fuse";
const MACFUSE_FILESYSTEM = "/Library/Filesystems/macfuse.fs";

export async function detectFUSEBackend(
  options: DetectFUSEBackendOptions = {},
): Promise<FUSEBackend> {
  const access = options.access ?? defaultAccess;
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const requested = env.WSD_FUSE_BACKEND ?? "auto";

  if (!isValidBackendPreference(requested)) {
    return { kind: "none", reason: `invalid WSD_FUSE_BACKEND=${JSON.stringify(requested)}` };
  }

  if (platform === "linux") {
    if (requested !== "auto" && requested !== "linux") {
      return { kind: "none", reason: `WSD_FUSE_BACKEND=${requested} is not supported on linux` };
    }

    return (await canAccess(access, LINUX_FUSE_DEVICE))
      ? { kind: "linux" }
      : { kind: "none", reason: "FUSE is unavailable because /dev/fuse is not accessible" };
  }

  if (platform === "darwin") {
    if (requested === "linux") {
      return { kind: "none", reason: "WSD_FUSE_BACKEND=linux is not supported on macOS" };
    }

    if (requested === "auto" || requested === "macfuse") {
      if (await canAccess(access, MACFUSE_FILESYSTEM)) {
        return { kind: "macfuse" };
      }

      if (requested === "macfuse") {
        return {
          kind: "none",
          reason: "macFUSE is unavailable; install macFUSE",
        };
      }
    }

    return { kind: "none", reason: "macFUSE is not installed" };
  }

  return { kind: "none", reason: `unsupported platform ${platform}` };
}

async function canAccess(access: (path: string) => Promise<void>, path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isValidBackendPreference(value: string): value is "auto" | "linux" | "macfuse" {
  return value === "auto" || value === "linux" || value === "macfuse";
}
