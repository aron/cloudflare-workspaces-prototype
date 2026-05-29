const FILE_TYPE = 0o100000;
const DIR_TYPE = 0o040000;

export type VfsNode = VfsDirectory | VfsFile;

export interface VfsDirectory {
  type: "dir";
  mode: number;
  mtimeMs: number;
  children: Map<string, VfsNode>;
}

export interface VfsFile {
  type: "file";
  mode: number;
  mtimeMs: number;
  data: Buffer;
  size: number;
}

export class MemoryVfs {
  readonly root: VfsDirectory;

  constructor() {
    this.root = {
      type: "dir",
      mode: DIR_TYPE | 0o755,
      mtimeMs: Date.now(),
      children: new Map(),
    };
  }

  exists(path: string): boolean {
    return this.get(path) !== undefined;
  }

  get(path: string): VfsNode | undefined {
    const parts = normalizePath(path);
    let node: VfsNode = this.root;

    for (const part of parts) {
      if (node.type !== "dir") {
        return undefined;
      }

      const child = node.children.get(part);
      if (child === undefined) {
        return undefined;
      }

      node = child;
    }

    return node;
  }

  mkdir(path: string, mode = 0o755): void {
    const parts = normalizePath(path);
    if (parts.length === 0) {
      return;
    }

    const { parent, name } = this.parent(parts);
    if (parent.children.has(name)) {
      throw new Error(`path already exists: ${path}`);
    }

    parent.children.set(name, {
      type: "dir",
      mode: DIR_TYPE | (mode & 0o7777),
      mtimeMs: Date.now(),
      children: new Map(),
    });
    touch(parent);
  }

  readdir(path: string): string[] {
    const node = this.get(path);
    if (node?.type !== "dir") {
      throw new Error(`not a directory: ${path}`);
    }

    return [...node.children.keys()].sort();
  }

  writeFile(path: string, data: Buffer, mode = 0o100644): void {
    const parts = normalizePath(path);
    const { parent, name } = this.parent(parts);
    parent.children.set(name, {
      type: "file",
      mode: FILE_TYPE | (mode & 0o7777),
      mtimeMs: Date.now(),
      data: Buffer.from(data),
      size: data.length,
    });
    touch(parent);
  }

  createFile(path: string, mode = 0o100644): void {
    this.writeFile(path, Buffer.alloc(0), mode);
  }

  readFile(path: string): Buffer {
    const node = this.get(path);
    if (node?.type !== "file") {
      throw new Error(`not a file: ${path}`);
    }

    return Buffer.from(node.data.subarray(0, node.size));
  }

  read(path: string, length: number, position: number): Buffer | undefined {
    const node = this.get(path);
    if (node?.type !== "file") {
      return undefined;
    }

    return Buffer.from(node.data.subarray(position, Math.min(position + length, node.size)));
  }

  write(path: string, data: Buffer, position: number): number {
    const node = this.get(path);
    if (node?.type !== "file") {
      return -1;
    }

    const needed = position + data.length;
    if (needed > node.data.length) {
      let nextSize = Math.max(node.data.length * 2, 64);
      while (nextSize < needed) {
        nextSize *= 2;
      }

      const next = Buffer.alloc(nextSize);
      node.data.copy(next, 0, 0, node.size);
      node.data = next;
    }

    data.copy(node.data, position);
    node.size = Math.max(node.size, needed);
    touch(node);
    return data.length;
  }

  truncate(path: string, size: number): boolean {
    const node = this.get(path);
    if (node?.type !== "file") {
      return false;
    }

    if (size > node.data.length) {
      const next = Buffer.alloc(size);
      node.data.copy(next, 0, 0, node.size);
      node.data = next;
    }

    if (size > node.size) {
      node.data.fill(0, node.size, size);
    }

    node.size = size;
    touch(node);
    return true;
  }

  unlink(path: string): boolean {
    const parts = normalizePath(path);
    const { parent, name } = this.parent(parts);
    const node = parent.children.get(name);
    if (node?.type !== "file") {
      return false;
    }

    parent.children.delete(name);
    touch(parent);
    return true;
  }

  rmdir(path: string): "ok" | "missing" | "not-empty" | "not-dir" {
    const parts = normalizePath(path);
    if (parts.length === 0) {
      return "not-empty";
    }

    const { parent, name } = this.parent(parts);
    const node = parent.children.get(name);
    if (node === undefined) {
      return "missing";
    }
    if (node.type !== "dir") {
      return "not-dir";
    }
    if (node.children.size > 0) {
      return "not-empty";
    }

    parent.children.delete(name);
    touch(parent);
    return "ok";
  }

  rename(source: string, destination: string): boolean {
    const sourceParts = normalizePath(source);
    const destinationParts = normalizePath(destination);
    const { parent: sourceParent, name: sourceName } = this.parent(sourceParts);
    const node = sourceParent.children.get(sourceName);
    if (node === undefined) {
      return false;
    }

    const { parent: destinationParent, name: destinationName } = this.parent(destinationParts);
    sourceParent.children.delete(sourceName);
    destinationParent.children.set(destinationName, node);
    touch(node);
    touch(sourceParent);
    touch(destinationParent);
    return true;
  }

  private parent(parts: string[]): { parent: VfsDirectory; name: string } {
    if (parts.length === 0) {
      throw new Error("root has no parent");
    }

    const name = parts.at(-1)!;
    const parentPath = `/${parts.slice(0, -1).join("/")}`;
    const parent = this.get(parentPath);
    if (parent?.type !== "dir") {
      throw new Error(`parent directory does not exist: ${parentPath}`);
    }

    return { parent, name };
  }
}

export function normalizePath(path: string): string[] {
  if (!path.startsWith("/")) {
    throw new Error(`path must be absolute: ${path}`);
  }
  if (path.includes("\0")) {
    throw new Error("path must not contain NUL bytes");
  }

  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      throw new Error(`path must not escape root: ${path}`);
    }

    parts.push(part);
  }

  return parts;
}

function touch(node: Pick<VfsNode, "mtimeMs">): void {
  node.mtimeMs = Date.now();
}
