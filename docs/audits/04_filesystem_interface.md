# Audit: `docs/04_filesystem_interface.md`

Spec-vs-implementation audit. Code is authoritative.

Scope: every claim in `docs/04_filesystem_interface.md` about
`Workspace.fs` — method names, signatures, parameter shapes, return
types, error semantics, encoding handling, streams, recursion, globs,
grep options, watch.

Sources traced:
- `packages/workspace-fs/src/fs/filesystem.ts`
- `packages/workspace-fs/src/fs/{readFile,writeFile,mkdir,rm,readdir,ls,stat,find,grep,readlink,symlink,watch,resolve}.ts`
- `packages/workspace-fs/src/{errors,index,provider,types}.ts`

The doc has a banner declaring itself the "intended design" and code
authoritative. Findings below are still tagged so we can decide per item
whether the doc target is worth keeping or the doc should be brought
down to what ships.

## Review

### Correct (doc matches code)

- **`readFile` signature & overloads** (`fs/readFile.ts:14–33`,
  `fs/filesystem.ts:44–58`). All three overloads documented in the doc
  block at L41–43 exist in code with identical shapes. Stream default,
  `"utf8"` → `string`, `{ encoding: "utf8" }` → `string`. The comment
  in `readFile.ts:14` even says "Overloads match
  docs/04_filesystem_interface.md exactly."
- **`readFile` semantics**: resolves to `ENOENT` for missing path
  (`readFile.ts:42`), `EISDIR` for a directory (`readFile.ts:45`). Both
  documented.
- **`writeFile` signature** (`fs/writeFile.ts:14–18, 114–123`). Accepts
  `string | Uint8Array | ReadableStream<Uint8Array>`; options has
  `mode?: number`. Matches doc L64–68.
- **`writeFile` stream handling**: streams are drained into a single
  buffer before chunking (`writeFile.ts:54–83`). The doc's "pipe through
  without buffering" claim (L71) is slightly aspirational but not
  contradicted — see Note below.
- **`writeFile` `EISDIR` on root** and parent `ENOENT`/`ENOTDIR` paths
  (`writeFile.ts:23–52, 136–137, 158–159`). All consistent with the
  error table.
- **`rm` signature & semantics** (`fs/rm.ts:8–11, 60–105`). `recursive`
  triggers walk; `force` swallows `ENOENT`; root deletion throws
  `EPERM`; non-empty directory without `recursive` → `ENOTEMPTY`. All
  documented at L94–98 and in the error table.
- **`mkdir` signature & semantics** (`fs/mkdir.ts:7–10, 67–122`).
  `recursive`, `mode`, `EEXIST` on existing path (even file), `ENOENT`
  on missing parents without `recursive`, `ENOTDIR` if a parent segment
  is a file. Matches doc L113–115 and the error table.
- **`readdir` shape** (`fs/readdir.ts:6–11`). `{ name, parentPath,
  isFile, isDirectory }` matches doc L125–130 verbatim. Throws
  `ENOTDIR` / `ENOENT` as expected (`readdir.ts:21–26`).
- **`stat` shape** (`fs/stat.ts:6–13, 15–39`). `{ name, mode, mtime,
  size, isFile, isDirectory }` matches doc L146–153. `size` is `0` for
  directories, summed chunk sizes for files. `mtime` is ms.
- **`find` signature & glob** (`fs/find.ts:6–9, 17–41`). Returns
  `Array<{ path; type: "file" | "dir" }>`. The simple `*` / `**` glob
  documented at L166 is what `compileGlob` actually accepts
  (`find.ts:67–97`).
- **`ls` signature** (`fs/ls.ts:35`). `(prefix: string) =>
  Promise<string[]>`. Files only, flat list. Matches doc L181 and the
  "Flat list of every file path" sentence at L184.
- **`grep` signature** (`fs/grep.ts:8–16, 18–23`). `pattern`, `path`,
  `options: { ignoreCase?: boolean }` → `Array<{ path; line; text }>`.
  Matches doc L198–202.
- **Error object shape** (`errors.ts:16–31`). The thrown object has
  `code`, `path?`, extends `Error` — compatible with the doc's
  "`NodeJS.ErrnoException`-shaped object with a `code` property"
  description (L217–219). `ENOENT`, `ENOTEMPTY`, `ENOTDIR`, `EISDIR`,
  `EEXIST`, `EINVAL`, `EPERM`, `EIO` are all both declared in the
  `WorkspaceErrorCode` union (`errors.ts:1–14`) and produced by the
  code paths.
- **Workspace root is structural** (`rm.ts:63–66`): `EPERM` matches the
  error-table row "deleting the workspace root".
- **Appendix mapping** is broadly accurate — `appendFile`, `truncate`,
  `chown`, `utimes`, `cp`, `rename`, `realpath`, `open`/`FileHandle` are
  genuinely absent from the public API.

### Doc-fix

- **`rm` option types** (doc L94 vs `fs/rm.ts:8–11`). Doc shows
  `{ recursive?: true; force?: true }` and code declares the same.
  Inconsistency is internal to the codebase (`true`-only literal,
  callers cannot pass `false`). The doc faithfully mirrors the code,
  but readers using `node:fs/promises` will write `recursive: false` /
  `force: false` and get a TS compile error. Either widen the type to
  `boolean` (code-fix) or call out the literal `true` constraint in the
  doc (doc-fix). Tag: `needs-decision`.
- **`mkdir` option types** (doc L114 vs `fs/mkdir.ts:7–10`). Same
  issue: `recursive?: true` literal in code and doc. Same
  recommendation. Tag: `needs-decision`.
- **`stat` documents no `name` source semantics** (doc L146–153). Code
  derives `name` from the canonicalized path's last segment
  (`stat.ts:16`), not from the dirent. For the root it's the empty
  string (see `path.ts` `canonicalizePath`). Worth a sentence in the
  doc clarifying that `stat("/").name === ""`. Tag: `doc-fix`.
- **`stat` does not throw `ENOTDIR` for `stat` of a path under a file**
  (`stat.ts:18–20` returns `ENOENT` via `resolveInode` returning
  `null`). The error table lists `ENOTDIR` for "a parent path segment
  is a file" (L225), but `stat` collapses this into `ENOENT` because
  `resolveInode` returns `null` for that case (`resolve.ts:73`). Other
  operations (`mkdir`, `writeFile`) do throw `ENOTDIR` explicitly. The
  error-table row is therefore not universal — note that some
  operations report this case as `ENOENT`. Tag: `doc-fix`.
- **`readFile` with `{ encoding: "utf8" }` typing** (doc L43,
  `fs/readFile.ts:22–27`, `fs/filesystem.ts:46`). The class overload
  returns `Promise<string | ReadableStream<Uint8Array>>` for the
  options form because `encoding` is optional in `ReadFileOptions`. The
  doc shows it as `Promise<string>` which is only true when
  `encoding === "utf8"`. If a caller passes `{}` they will get a
  stream, not a string. Either make encoding required when the options
  overload is used in the doc, or document the wider return. Tag:
  `doc-fix`.
- **`grep` is substring, not regex** (`grep.ts:99` uses
  `haystack.includes(needle)`). Doc parameter is named `pattern` and
  the doc says nothing either way (L199), but readers will assume
  regex. State explicitly that `pattern` is a literal substring (no
  regex, no glob). Tag: `doc-fix`.
- **`grep` returns matches in walk order; `text` is the entire matching
  line; `line` is 1-indexed** (`grep.ts:48–106`). The doc could note
  the 1-indexing and that `text` is the whole line (not just the
  match). Tag: `doc-fix`.
- **`grep` accepts a file path too**, not just a directory
  (`grep.ts:30–35`). Doc only shows the directory case (L206). Worth a
  one-liner. Tag: `doc-fix`.
- **`find` resolves the directory first**: throws `ENOENT` if the
  directory is missing and `ENOTDIR` if it's a file (`find.ts:20–25`).
  Not documented. Tag: `doc-fix`.
- **`find` glob is matched against the path *relative* to the search
  root** (`find.ts:36–41`). Doc shows `**/*.ts` but doesn't say the
  match is rel-rooted. Worth one line. Tag: `doc-fix`.
- **`ls` prefix matching is exact-segment**: `/wsp` will not match
  `/workspace/x` because the SQL requires `path = prefix` or
  `path LIKE prefix || '/%'` (`fs/ls.ts:20–33`). The doc reads "every
  file path that starts with `prefix`" (L184) which technically
  promises string-prefix semantics, including spurious matches across a
  segment boundary. Either tighten the wording ("under the directory
  `prefix`, or the file at `prefix`") or change the doc to admit the
  segment-aware behaviour (which is the more useful one). Tag:
  `doc-fix`.
- **`ls` silently returns `[]` for a non-existent prefix**
  (`ls.ts:35–40`). The doc's error table strongly implies `ENOENT`
  everywhere it might apply. Should be called out as an explicit
  exception, since the SQL CTE drives the result and never checks
  existence. Tag: `doc-fix`.
- **`watch` is listed as absent in the appendix** (doc L303 maps
  `watch → —`). It is implemented: `fs/watch.ts` exposes
  `createWatcher` (EventEmitter, `WatchHandle`, `WatchOptions { recursive,
  signal, interval }`) and `createWatchAsyncIterable`. It is not
  attached to `WorkspaceFilesystem` (no `fs.watch(...)` method on the
  class), but the capability exists. The appendix line is misleading
  — either expose `watch()` on the class (code-fix) or note that the
  primitive exists but is consumed via the provider / sync layer
  (doc-fix). Tag: `needs-decision`.
- **Symlinks: doc says "No symlink support" / "VFS has no symlinks"**
  (doc L294, L302). Code disagrees: `fs/symlink.ts` creates symlink
  nodes, `fs/readlink.ts` reads them, `resolve.ts:38–112` follows them
  with a 40-deep loop cap and throws `ELOOP`. `stat` follows symlinks
  transparently; there is no `lstat`. Two reasonable doc updates:
  (1) drop the "no symlinks" claim and document
  `symlink`/`readlink`/`ELOOP`; or (2) mark the symlink code as
  internal-only and keep the public surface symlink-free in the doc.
  Either way the doc is currently wrong. Tag: `needs-decision`.
- **`ELOOP` is missing from the error-code table** (doc L221–232)
  despite being thrown by `resolve.ts:93` whenever symlink traversal
  exceeds 40 hops. If symlinks stay (see above), add `ELOOP`. Tag:
  `doc-fix`.
- **`EACCES` and `EROFS` are listed in the error table** (doc L229,
  L231) but no code path in `packages/workspace-fs/src/**` ever creates
  them (`grep` for them only finds the enum entry in `errors.ts`).
  These belong to mount / shell layers that aren't shipped yet. The
  doc should either drop them or mark them as "reserved for future
  mount layer (see 06_mount_interface.md)". The `EROFS` example at
  L268–277 will currently never trigger. Tag: `doc-fix`.
- **`EINVAL` for "invalid path"** — code uses `invalidPath()`
  (`errors.ts:33`) and also throws `EINVAL` from `readlink` on non-
  symlinks (`readlink.ts:14`). Doc covers it broadly enough. No
  change needed.
- **`writeFile` "Stream an HTTP upload straight to disk" example**
  (doc L80–81). Code buffers the entire stream in memory before
  hashing/chunking (`writeFile.ts:54–83`). The example reads as a
  zero-copy path which is not what ships. Either tone the example
  down ("uploads can be supplied as a stream") or implement true
  streaming chunking. Tag: `needs-decision` (flagged as
  "drift where code wins but doc target still valuable").
- **`writeFile`'s `mode` is masked to 12 bits** (`writeFile.ts:139`,
  `mkdir.ts:70`). The doc's `0o755` and `0o644` defaults match. No
  change.
- **Appendix says `glob → find` "Limited glob support"** (doc L305).
  Accurate — only `*`, `**`, `**/` are honored; `?`, `[...]`, `{a,b}`
  are literal. Could be more explicit but not wrong. Tag: `doc-fix`
  (optional clarification).
- **Appendix says `chmod → Pass mode to writeFile / mkdir`** (doc
  L296). True at create time, but there is no way to chmod an existing
  file without rewriting its bytes. Worth calling out so callers
  don't expect `writeFile(path, existingContents, { mode })` to be
  cheap. Tag: `doc-fix`.

### Code-fix candidates (doc target worth keeping)

- **Widen `RmOptions` / `MkdirOptions` boolean fields to `boolean`**
  rather than `true`-only literals. The `node:fs/promises` family
  accepts `false`; the literal type breaks porting and surprises TS
  users. Doc as written is fine if this is fixed. Tag: `code-fix`.
- **Expose `watch` on `WorkspaceFilesystem`** so the doc's
  `node:fs/promises` parity story is complete. The primitive in
  `fs/watch.ts` is already there; a thin `fs.watch(path, options)`
  binding on the class would close the gap the appendix flags as
  missing. Tag: `code-fix` (or `needs-decision` on whether watching
  belongs on `fs` vs `Workspace`).
- **Surface true streaming write** so that the `writeFile(stream)`
  story isn't a lie about memory. Tag: `code-fix` (longer-horizon —
  matches the TODO comment at `writeFile.ts:61–64`).

### Blocker

- None for documentation honesty — the doc carries a banner saying it
  describes intent, not shipped behaviour. Drift in `ls` prefix
  semantics, `grep` substring vs regex, symlink existence, and absent
  `EACCES`/`EROFS` are still worth fixing because they will mislead
  agents reading the doc.

### Note

- The doc's banner (L3–9) explicitly admits divergence. Treat every
  "doc-fix" above as bringing the doc closer to shipped behaviour, not
  punishing intent. Items marked `needs-decision` are the ones where
  the design target may still be the right destination.
- Path canonicalization (POSIX absolute paths) is enforced by
  `canonicalizePath` in `path.ts`; the doc's statement that paths are
  "absolute and POSIX-style" (L26–27) is accurate.
- Error path field: `WorkspaceFsError.path` is populated for every
  call site I traced; if the doc wants to promise a `path` property on
  the thrown object alongside `code`, that promise can be added
  truthfully.

## Files reviewed
- `docs/04_filesystem_interface.md` (308 lines)
- `packages/workspace-fs/src/fs/filesystem.ts`
- `packages/workspace-fs/src/fs/readFile.ts`
- `packages/workspace-fs/src/fs/writeFile.ts`
- `packages/workspace-fs/src/fs/rm.ts`
- `packages/workspace-fs/src/fs/mkdir.ts`
- `packages/workspace-fs/src/fs/readdir.ts`
- `packages/workspace-fs/src/fs/stat.ts`
- `packages/workspace-fs/src/fs/find.ts`
- `packages/workspace-fs/src/fs/ls.ts`
- `packages/workspace-fs/src/fs/grep.ts`
- `packages/workspace-fs/src/fs/readlink.ts`
- `packages/workspace-fs/src/fs/symlink.ts`
- `packages/workspace-fs/src/fs/watch.ts`
- `packages/workspace-fs/src/fs/resolve.ts`
- `packages/workspace-fs/src/errors.ts`
- `packages/workspace-fs/src/index.ts`
