# tauri-plugin-content-update

Over-the-air updates of a Tauri 2 app's web content (its frontend bundle), with per-file delta
downloads, automatic rollback and native compatibility checks. Tested on Android and Linux desktop,
written for every platform Tauri supports.

- **Plain static hosting.** A bundle is a folder with a `manifest.json` and content-addressed
  `files/<sha256>` blobs. Any static server or CDN works.
- **Delta updates.** Only files whose content isn't on the device yet are downloaded. The plugin looks
  in the app's embedded (built-in) bundle and in the installed bundles; local files are hard-linked or
  copied. An interrupted download resumes per file, even across app restarts.
- **Verified.** Every file is checked against its sha256 and size. Paths that would leave the bundle
  directory are refused.
- **Safe activation.** A new bundle is on trial until the web app calls `notifyReady()`. If that
  doesn't happen within `readyTimeout`, or the process dies first, the previous bundle comes back and
  the version is marked failed.
- **Native compatibility.** A bundle is only installed if the app can run it: it must not call native
  API (commands, plugins, permissions) the app doesn't have, which is detected automatically, and
  `minNativeVersion` can require a newer app explicitly. Otherwise the app is told that it needs an
  update from the store (`updateRequired`), also offline. A new native binary always drops downloaded
  bundles in favour of its own embedded bundle.
- **No server-side logic.** The server's manifest is the source of truth: whatever version it lists
  gets installed (versions aren't compared). To roll back, republish an older bundle, including the
  built-in one, which needs no download.

It ships as three parts that are used together:

| Package                             | Kind                     | What                                                                              |
| ----------------------------------- | ------------------------ | --------------------------------------------------------------------------------- |
| `tauri-plugin-content-update`       | crate                    | the Tauri plugin                                                                  |
| `tauri-plugin-content-update-build` | crate (build-dependency) | `build.rs` helper: the app's native API hashes and typed bindings of its commands |
| `tauri-plugin-content-update`       | npm                      | the JS API and the `content-update` CLI (bundler, bindings generator)             |

The Rust side is split in two because the build helper runs on the build host (it parses the app's
sources and capabilities) and would otherwise pull tauri's runtime into the build script.

## Setup

**1. Dependencies (`src-tauri/Cargo.toml`):**

```toml
[dependencies]
tauri-plugin-content-update = "0.1"
serde_json = "1" # generate_context!() emits plugin config as serde_json values

[build-dependencies]
tauri-build = { version = "2", features = [] }
tauri-plugin-content-update-build = "0.1"
```

```sh
pnpm add tauri-plugin-content-update # npm i / yarn add work too
```

Until the packages are published, use path (or git) dependencies: `{ path = "<repo>" }` and
`{ path = "<repo>/build" }` for the crates, `pnpm link <repo>` for the npm package.

**2. `src-tauri/build.rs`:**

```rust
fn main() {
    tauri_build::build();
    // after tauri_build, which resolves the plugins' permissions
    tauri_plugin_content_update_build::Builder::new()
        .bindings("../src/native.gen.ts")
        .build();
}
```

**3. The app (`src-tauri/src/lib.rs`):**

```rust
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut context = tauri::generate_context!();
    // serves the active downloaded bundle; the embedded assets stay the built-in one
    tauri_plugin_content_update::wrap_assets(&mut context);
    tauri::Builder::default()
        // the native API this build provides (computed by build.rs)
        .plugin(tauri_plugin_content_update::init(
            tauri_plugin_content_update::native_api!(),
        ))
        .invoke_handler(tauri::generate_handler![/* … */])
        .run(context)
        .expect("error while running tauri application");
}
```

Plugins can't change the `Context`, hence the extra `wrap_assets()` line.

**4. Permissions:** add `"content-update:default"` to the window's capability.

**5. Build and configuration.** In `package.json`, a script that generates the bindings, builds the
frontend, then stamps and publishes it (see [Publishing](#publishing)):

```json
"scripts": {
  "build:app": "content-update bindings src-tauri src/native.gen.ts && vite build && content-update bundle dist --out dist-update"
}
```

`tauri.conf.json`:

```json
"build": {
  "beforeBuildCommand": "pnpm build:app",
  "frontendDist": "../dist"
},
"plugins": {
  "content-update": {
    "manifestUrl": "https://example.com/app-update/manifest.json",
    "readyTimeout": 10000,
    "concurrency": 4
  }
}
```

- `manifestUrl`: where the published manifest is; `null` (the default) disables update checks.
- `readyTimeout`: ms a new bundle has to call `notifyReady()`, defaults to 10000.
- `concurrency`: parallel file downloads, defaults to 4.

**6. The frontend**, once at startup:

```ts
import { sync } from "tauri-plugin-content-update";

// confirms the running bundle, then checks, downloads and stages the published version for the
// next launch (`sync({ apply: "now" })` reloads into it right away). Never throws.
const { status, updateRequired } = await sync();
if (updateRequired) {
  // this app can't run the published version: show your own "please update the app" UI
}
```

The plugin has no UI: what to show when the app needs a store update (a blocking dialog, a banner,
nothing) is up to the app. `updateRequired` comes from the plugin's persisted state, so it is also
known offline.

Call the app's own commands through the generated bindings (`import { appInfo } from
"./native.gen"`), not with `invoke()`: that is how the bundler sees which commands a bundle uses.
Commit the bindings file, so the frontend typechecks without a build; every Cargo build (`tauri dev`
too) and `content-update bindings` regenerate it.

## Publishing

```sh
content-update bundle <frontendDist> --out <dir> [--version <v>] [--min-native-version <code>]
                      [--native-api <id>]...
content-update bindings <crate-dir> <out>
```

`content-update bundle`, run after the web build and before Tauri embeds it:

- **Stamps** `<frontendDist>/content-update.json`. It is embedded into the app, so the app knows its
  built-in version and can reuse its files for delta downloads.
- **Publishes** to `<dir>`: `manifest.json` and `files/<sha256>`. Serve `<dir>` statically, with
  `manifest.json` uncached and `files/*` cached forever. Blobs of older versions can stay; the manifest
  is written last.
- `<dir>` must not be inside `frontendDist`, or every update folder gets embedded into the app.
- `--version` defaults to a hash of the file list (env fallback `CONTENT_UPDATE_VERSION`).
- `--min-native-version` (env `CONTENT_UPDATE_MIN_NATIVE_VERSION`): see below.
- `--native-api <id>` declares native API the scan can't see (e.g. `plugin:fs|read_file` invoked with
  a computed name).

To ship an update, build the frontend the same way and upload `<dir>`. The bundler is also available
as a library: `tauri-plugin-content-update/bundle` (`createBundle`, `createManifest`,
`findNativeApi`, `nativeApiHash`).

## API

```ts
import {
  ContentUpdate,
  ContentUpdateError,
  sync,
} from "tauri-plugin-content-update";
```

|                                            |                                                                                                                                                                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sync({ url?, apply? })`                   | `notifyReady()`, then `download()`; `apply: "now"` also `apply()`s. Returns the result with `updateRequired`, never throws (`status: "error"`, `"disabled"` without a manifest url, `"unsupported"` outside Tauri) |
| `ContentUpdate.getState()`                 | `currentVersion`, `isBuiltin`, `builtinVersion`, `nextVersion`, `pendingReady`, `failedVersions`, `incompatibleVersion`, `nativeVersionCode`, `manifestUrl`                                                        |
| `ContentUpdate.notifyReady()`              | confirms the running bundle; without it a new bundle is rolled back                                                                                                                                                |
| `ContentUpdate.check({ url? })`            | `{ status, version, currentVersion, minNativeVersion, reason?, downloadSize?, downloadFiles? }`, downloads nothing                                                                                                 |
| `ContentUpdate.download({ url?, force? })` | downloads and stages; `force` retries a failed version                                                                                                                                                             |
| `ContentUpdate.apply()`                    | activates the staged bundle now (reloads)                                                                                                                                                                          |
| `ContentUpdate.reset()`                    | back to the built-in bundle now (reloads), forgets failed versions                                                                                                                                                 |
| `ContentUpdate.onDownloadProgress(cb)`     | event `content-update://download-progress`: `{ version, loaded, total, files, totalFiles }`                                                                                                                        |
| `ContentUpdate.onRollback(cb)`             | event `content-update://rollback`: `{ failedVersion, version }`                                                                                                                                                    |

- `status` is one of `available`, `up-to-date`, `staged`, `failed` or `incompatible`. `reason`
  (`nativeApi` or `nativeVersion`) explains `incompatible`; `force` doesn't override it.
- Errors are `ContentUpdateError`s with a `code`: `NO_URL`, `BUSY`, `NO_UPDATE`, `CHECK_FAILED`,
  `DOWNLOAD_FAILED`, `NOT_WRAPPED` (`wrap_assets()` wasn't called) or `IO`.
- The raw commands are `plugin:content-update|get_state`, `notify_ready`, `check`, `download`,
  `apply` and `reset`.

## How it works

Tauri serves the frontend through the `Assets` provider of the app's `Context` (embedded into the
binary by `generate_context!()`). `wrap_assets()` swaps in a provider that serves the active
downloaded bundle from disk. The original provider is kept, both as the built-in bundle and as a source
of files for delta updates.

Tauri's own protocol handler keeps doing its job: mime types, the SPA fallback to `index.html`, and
CSP. Switching bundles reloads the webviews. This is the hook the Tauri team suggests for custom asset
resolution; it's cleaner than overriding the `tauri` URI scheme, which replaces Tauri's whole handler.

**State** lives in `<app_data_dir>/content-update/`:

- `state.json`: the current, previous and staged bundle, the trial flag, failed versions, the
  incompatible version and the binary identity. It's written atomically.
- `bundles/<version>/`: complete bundles, each with its manifest as `content-update.json`.
- `staging/<version>/`: a download in progress.

**A new binary** is detected by the path, size and modification time of the file the plugin's code
was loaded from: on Android `/data/app/~~…/base.apk!/lib/…`, whose directory changes on every
install; on desktop the executable.

**Boot** runs once per process: rolling back an unconfirmed trial, then promoting the staged bundle.
On Android an activity recreation (e.g. a configuration change) keeps the Rust side and recreates the
webview, which loads the same bundle again, so it isn't counted as a failed launch.

## Native compatibility

The web bundle and the native app share a contract: the commands the frontend calls, with their
argument and result types. An app that is never updated from the store keeps receiving new web
bundles, so a bundle built against a newer native side must not be installed on it.

### Native API hashes

The native API is a set of hashes, one per thing the frontend can call:

- **App commands:** every command registered with `generate_handler!`, hashed with its signature: the
  command name, the argument keys (as sent from JS), and the wire shape of the argument, result and
  error types. Struct and enum definitions are expanded with their `#[serde(…)]` attributes. Docs,
  formatting, Rust type names and injected arguments (`AppHandle`, `State`, …) don't count.
- **Plugin commands:** `plugin:<plugin>|<command>` for every plugin command a capability allows (for
  local content, on the target platform). They are resolved from the app's capabilities with Tauri's
  own ACL code, so a missing plugin and a missing permission both count as missing.

A hash is the first 12 hex characters of the sha256 of the id. A manifest only reveals which hashes a
bundle needs, not the command names or types.

**Build time (the app's `build.rs`).** `tauri-plugin-content-update-build`:

- reads the app's sources (`src/**/*.rs`) and its capabilities;
- generates TypeScript bindings of the app's commands. Each binding calls its command with an id
  `native-api:<command>:<hash>`;
- writes the hashes the app provides to `$OUT_DIR`, which `native_api!()` includes;
- outside of `tauri dev`, fails the build if the embedded web bundle needs a hash the build doesn't
  provide (a safety net, e.g. a frontend built with stale bindings).

**Before the web build.** `tauri build` builds the frontend (`beforeBuildCommand`) before the Rust
code, so the bindings `build.rs` writes would come too late for a changed command.
`content-update bindings` (a JS port of the generator, `lib/bindings.mjs`) writes the same file
first.

**Bundle time.** `content-update bundle` scans the build's code (`.js`, `.mjs`, `.cjs`, `.html`) for
`plugin:<plugin>|<command>` strings and binding ids, and writes their hashes to the manifest's
`requires`. The scan runs on the output, so app commands that were tree-shaken away don't count.

**Install time.** `check()`/`download()` compare the manifest's `requires` and `minNativeVersion`
with the app. If the app is missing something, the status is `incompatible`, with a `reason`:

- `nativeApi`: a required hash is missing;
- `nativeVersion`: `minNativeVersion` is above the app's version code (the Android `versionCode`,
  i.e. `bundle.android.versionCode`, or else `major*1000000 + minor*1000 + patch` of the app version).

Nothing is downloaded, and the version is remembered as `incompatibleVersion` until a version the app
can run is published, or the app is updated.

**Boot time.** Before the webview loads anything, the plugin checks the bundle it is about to serve,
and the staged one, against the running binary. Normally they pass, because they were checked before
the download and a new binary drops them. If the binary changed without being detected as new, a
bundle it can't run isn't served: the app falls back to the built-in bundle, and the version becomes
`incompatibleVersion`. Nothing is checked when a command is called.

**What isn't detected:**

- Behaviour changes behind an unchanged signature: bump `minNativeVersion` for those.
- Commands invoked with computed names: declare them with `--native-api <id>`.
- App commands invoked without the generated bindings.
- Signature changes of third-party plugin commands, which are identified by name only.
- Types with hand-written `Serialize`/`Deserialize` impls, which are hashed by their definition.

The canonical signature format is part of the hash format: changing it changes every app command
hash, so bundles built afterwards are `incompatible` with apps built before.

## Manifest

```json
{
  "version": "3f2a9c0d1e2b4a5c",
  "minNativeVersion": 1000,
  "requires": ["240505d45b3b", "419cc273665f"],
  "files": {
    "index.html": { "sha256": "…", "size": 1234 },
    "assets/index-BEDKjdEN.js": { "sha256": "…", "size": 76391 }
  }
}
```

- `version` must match `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`.
- `minNativeVersion` and `requires` are optional.
- Every file is fetched from `files/<sha256>`, resolved relative to the manifest URL.

## Caveats

- **HTTPS trust:** downloads use rustls with the bundled Mozilla root certificates (`webpki-roots`),
  so CAs installed on the device aren't trusted.
- **Unsigned manifests:** integrity relies on HTTPS for the manifest, and the file hashes cover the
  rest.
- **CSP:** a CSP with script hashes only works for the embedded bundle, because Tauri computes the
  hashes at compile time. Downloaded bundles are served without them.
- **Logging:** the plugin logs through the `log` crate. Install a logger (e.g. `tauri-plugin-log`) to
  see its messages in logcat or stdout.
- **App stores:** check your store's policy on downloading code; updating web content of an app is
  commonly allowed as long as it doesn't change the app's purpose.

## Development

```
src/, build.rs, permissions/   the plugin crate
build/                         the build helper crate (fixtures/: shared generator test cases)
guest-js/                      the JS API
lib/, bin/                     the bundler and the bindings generator (JS), the CLI
```

`shell.nix` provides the toolchain on NixOS (`nix-shell --run '…'`); elsewhere you need Rust, Node
≥ 20, pnpm and Tauri's Linux dependencies.

```sh
pnpm install
cargo test --workspace   # the plugin (needs Tauri's Linux deps) and the build helper
pnpm test                # the bundler and the JS bindings generator
cargo clippy --workspace --all-targets && cargo fmt --all && pnpm format
```

The bindings generator exists twice, in Rust (`build/src/rust.rs`, `render` in `build/src/lib.rs`)
and in JS (`lib/bindings.mjs`), and both must produce byte-identical output. Change both, and add
cases to `build/fixtures/<case>/src/**/*.rs` with the expected `bindings.ts` + `signatures.txt` (or
`error.txt`); `UPDATE_FIXTURES=1 cargo test -p tauri-plugin-content-update-build` rewrites them from
the Rust output, and `pnpm test` checks the JS output against them.

## License

MIT
