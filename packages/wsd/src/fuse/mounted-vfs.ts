import { posix } from "node:path";
import {
  create,
  type MkdirOptions,
  type ReaddirOptions,
  type StatOptions,
  type VFSStatWatcher,
  type VFSWatchAsyncIterable,
  type VFSWatcher,
  VirtualProvider,
  type VirtualStats,
  type WatchFileOptions,
  type WatchOptions,
} from "@platformatic/vfs";
import type { NodeVirtualFileSystem } from "./vfs.js";

export function createMountedVfs(vfs: NodeVirtualFileSystem, root: string): NodeVirtualFileSystem {
  const vfsRoot = normaliseVfsRoot(root);
  if (vfsRoot === "/") return vfs;
  return create(new MountedSubtreeProvider(vfs.provider, vfsRoot), { moduleHooks: false });
}

export function normaliseVfsRoot(root: string): string {
  if (!posix.isAbsolute(root)) {
    throw new Error(`VFS_ROOT must be an absolute path, got ${JSON.stringify(root)}`);
  }
  if (root.includes("\0")) {
    throw new Error("VFS_ROOT must not contain NUL bytes");
  }
  const normalised = posix.normalize(root).replace(/\/+$/, "");
  return normalised === "" ? "/" : normalised;
}

interface MountedDirent {
  name: string;
  path: string;
  parentPath: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
}

interface ProviderFdExtensions {
  closeSync(fd: number): void;
  readSync(
    fd: number,
    buffer: Buffer | Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ): number;
  writeSync(
    fd: number,
    buffer: Buffer | Uint8Array,
    offset?: number,
    length?: number,
    position?: number | null,
  ): number;
  fstatSync(fd: number, options?: StatOptions): VirtualStats;
  truncateSync(path: string, len: number): void;
  ftruncateSync(fd: number, len: number): void;
}

// Presents a backing VFS subtree as the mounted filesystem root.
// Mount consumers operate in this namespace; path arguments are
// translated to the backing namespace at this provider boundary.
class MountedSubtreeProvider extends VirtualProvider {
  constructor(
    private readonly inner: VirtualProvider,
    private readonly root: string,
  ) {
    super();
  }

  override get readonly(): boolean {
    return this.inner.readonly;
  }

  override get supportsSymlinks(): boolean {
    return this.inner.supportsSymlinks;
  }

  override get supportsWatch(): boolean {
    return this.inner.supportsWatch;
  }

  override open(path: string, flags?: string, mode?: number): Promise<unknown> {
    return this.inner.open(this.toBackingPath(path), flags, mode);
  }

  override openSync(path: string, flags?: string, mode?: number): unknown {
    return this.inner.openSync(this.toBackingPath(path), flags, mode);
  }

  override stat(path: string, options?: StatOptions) {
    return this.inner.stat(this.toBackingPath(path), options);
  }

  override statSync(path: string, options?: StatOptions) {
    return this.inner.statSync(this.toBackingPath(path), options);
  }

  override lstat(path: string, options?: StatOptions) {
    return this.inner.lstat(this.toBackingPath(path), options);
  }

  override lstatSync(path: string, options?: StatOptions) {
    return this.inner.lstatSync(this.toBackingPath(path), options);
  }

  // Dirents are path-valued results. Keep entry names unchanged,
  // but report parent/full paths in the mounted namespace.
  override async readdir(path: string, options?: ReaddirOptions) {
    return this.mapDirents(await this.inner.readdir(this.toBackingPath(path), options), options);
  }

  override readdirSync(path: string, options?: ReaddirOptions) {
    return this.mapDirents(this.inner.readdirSync(this.toBackingPath(path), options), options);
  }

  override async mkdir(path: string, options?: MkdirOptions) {
    const created = await this.inner.mkdir(this.toBackingPath(path), options);
    return created === undefined ? undefined : this.toMountPath(created);
  }

  override mkdirSync(path: string, options?: MkdirOptions) {
    const created = this.inner.mkdirSync(this.toBackingPath(path), options);
    return created === undefined ? undefined : this.toMountPath(created);
  }

  override rmdir(path: string) {
    return this.inner.rmdir(this.toBackingPath(path));
  }

  override rmdirSync(path: string): void {
    this.inner.rmdirSync(this.toBackingPath(path));
  }

  override unlink(path: string) {
    return this.inner.unlink(this.toBackingPath(path));
  }

  override unlinkSync(path: string): void {
    this.inner.unlinkSync(this.toBackingPath(path));
  }

  override rename(oldPath: string, newPath: string) {
    return this.inner.rename(this.toBackingPath(oldPath), this.toBackingPath(newPath));
  }

  override renameSync(oldPath: string, newPath: string): void {
    this.inner.renameSync(this.toBackingPath(oldPath), this.toBackingPath(newPath));
  }

  override readFile(
    path: string,
    options?: BufferEncoding | { encoding?: BufferEncoding | null } | null,
  ) {
    return this.inner.readFile(this.toBackingPath(path), options);
  }

  override readFileSync(
    path: string,
    options?: BufferEncoding | { encoding?: BufferEncoding | null } | null,
  ) {
    return this.inner.readFileSync(this.toBackingPath(path), options);
  }

  override writeFile(
    path: string,
    data: string | Buffer,
    options?: { encoding?: BufferEncoding; mode?: number } | BufferEncoding,
  ) {
    return this.inner.writeFile(this.toBackingPath(path), data, options);
  }

  override writeFileSync(
    path: string,
    data: string | Buffer,
    options?: { encoding?: BufferEncoding; mode?: number } | BufferEncoding,
  ): void {
    this.inner.writeFileSync(this.toBackingPath(path), data, options);
  }

  override appendFile(
    path: string,
    data: string | Buffer,
    options?: { encoding?: BufferEncoding; mode?: number } | BufferEncoding,
  ) {
    return this.inner.appendFile(this.toBackingPath(path), data, options);
  }

  override appendFileSync(
    path: string,
    data: string | Buffer,
    options?: { encoding?: BufferEncoding; mode?: number } | BufferEncoding,
  ): void {
    this.inner.appendFileSync(this.toBackingPath(path), data, options);
  }

  override exists(path: string) {
    return this.inner.exists(this.toBackingPath(path));
  }

  override existsSync(path: string): boolean {
    return this.inner.existsSync(this.toBackingPath(path));
  }

  override copyFile(src: string, dest: string, mode?: number) {
    return this.inner.copyFile(this.toBackingPath(src), this.toBackingPath(dest), mode);
  }

  override copyFileSync(src: string, dest: string, mode?: number): void {
    this.inner.copyFileSync(this.toBackingPath(src), this.toBackingPath(dest), mode);
  }

  override internalModuleStat(path: string): number {
    return this.inner.internalModuleStat(this.toBackingPath(path));
  }

  // realpath returns paths visible to mounted consumers, so translate
  // the backing provider's absolute result into the mount namespace.
  override async realpath(path: string, options?: { encoding?: BufferEncoding }) {
    return this.toMountPath(await this.inner.realpath(this.toBackingPath(path), options));
  }

  override realpathSync(path: string, options?: { encoding?: BufferEncoding }): string {
    return this.toMountPath(this.inner.realpathSync(this.toBackingPath(path), options));
  }

  override access(path: string, mode?: number) {
    return this.inner.access(this.toBackingPath(path), mode);
  }

  override accessSync(path: string, mode?: number): void {
    this.inner.accessSync(this.toBackingPath(path), mode);
  }

  override readlink(path: string, options?: { encoding?: BufferEncoding }) {
    return this.inner.readlink(this.toBackingPath(path), options);
  }

  override readlinkSync(path: string, options?: { encoding?: BufferEncoding }): string {
    return this.inner.readlinkSync(this.toBackingPath(path), options);
  }

  // Symlink target text is stored as the mounted filesystem sees it.
  // Only the link path is translated into the backing namespace.
  override symlink(target: string, path: string, type?: string) {
    return this.inner.symlink(target, this.toBackingPath(path), type);
  }

  override symlinkSync(target: string, path: string, type?: string): void {
    this.inner.symlinkSync(target, this.toBackingPath(path), type);
  }

  override watch(path: string, options?: WatchOptions): VFSWatcher {
    return this.inner.watch(this.toBackingPath(path), options);
  }

  override watchAsync(path: string, options?: WatchOptions): VFSWatchAsyncIterable {
    return this.inner.watchAsync(this.toBackingPath(path), options);
  }

  override watchFile(
    path: string,
    options?: WatchFileOptions,
    listener?: (curr: VirtualStats, prev: VirtualStats) => void,
  ): VFSStatWatcher {
    return this.inner.watchFile(this.toBackingPath(path), options, listener);
  }

  override unwatchFile(
    path: string,
    listener?: (curr: VirtualStats, prev: VirtualStats) => void,
  ): void {
    this.inner.unwatchFile(this.toBackingPath(path), listener);
  }

  // @platformatic/vfs routes openSync through provider-specific file
  // descriptor extensions when the backing provider exposes them.
  // Numeric fd operations carry provider state; only path-bearing
  // truncateSync needs namespace translation in this block.
  closeSync(fd: number): void {
    this.fdProvider.closeSync(fd);
  }

  readSync(
    fd: number,
    buffer: Buffer | Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ): number {
    return this.fdProvider.readSync(fd, buffer, offset, length, position);
  }

  writeSync(
    fd: number,
    buffer: Buffer | Uint8Array,
    offset?: number,
    length?: number,
    position?: number | null,
  ): number {
    return this.fdProvider.writeSync(fd, buffer, offset, length, position);
  }

  fstatSync(fd: number, options?: StatOptions): VirtualStats {
    return this.fdProvider.fstatSync(fd, options);
  }

  truncateSync(path: string, len: number): void {
    this.fdProvider.truncateSync(this.toBackingPath(path), len);
  }

  ftruncateSync(fd: number, len: number): void {
    this.fdProvider.ftruncateSync(fd, len);
  }

  private get fdProvider(): ProviderFdExtensions {
    return this.inner as VirtualProvider & ProviderFdExtensions;
  }

  private mapDirents(
    entries: string[] | MountedDirent[],
    options: ReaddirOptions | undefined,
  ): string[] | MountedDirent[] {
    if (options?.withFileTypes !== true) return entries;
    return (entries as MountedDirent[]).map((entry) => ({
      name: entry.name,
      path: this.toMountPath(entry.path),
      parentPath: this.toMountPath(entry.parentPath),
      isFile: () => entry.isFile(),
      isDirectory: () => entry.isDirectory(),
      isSymbolicLink: () => entry.isSymbolicLink(),
      isBlockDevice: () => entry.isBlockDevice(),
      isCharacterDevice: () => entry.isCharacterDevice(),
      isFIFO: () => entry.isFIFO(),
      isSocket: () => entry.isSocket(),
    }));
  }

  private toBackingPath(path: string): string {
    return joinRoot(this.root, path);
  }

  private toMountPath(path: string): string {
    const normalised = posix.normalize(path);
    if (normalised === this.root) return "/";
    const prefix = `${this.root}/`;
    return normalised.startsWith(prefix) ? `/${normalised.slice(prefix.length)}` : normalised;
  }
}

function joinRoot(root: string, path: string): string {
  const absolute = path.startsWith("/") ? path : `/${path}`;
  const suffix = posix.normalize(absolute);
  if (suffix === "/") return root;
  return `${root}${suffix}`;
}
