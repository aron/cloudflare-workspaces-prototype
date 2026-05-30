declare module "node-vfs-polyfill" {
  export interface VirtualStats {
    size: number;
    mode: number;
    mtime: Date;
    atime: Date;
    ctime: Date;
    isFile(): boolean;
    isDirectory(): boolean;
  }

  export class MemoryProvider {}

  export interface VirtualFileSystem {
    existsSync(path: string): boolean;
    statSync(path: string): VirtualStats;
    readFileSync(path: string): Buffer;
    writeFileSync(path: string, data: Buffer | string, options?: { mode?: number }): void;
    readdirSync(path: string): string[];
    mkdirSync(path: string, options?: { mode?: number; recursive?: boolean }): string | undefined;
    rmdirSync(path: string): void;
    unlinkSync(path: string): void;
    renameSync(source: string, destination: string): void;
    accessSync(path: string, mode?: number): void;
  }

  export function create(provider?: MemoryProvider): VirtualFileSystem;
}
