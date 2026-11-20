# Changelog

## 0.1.0

Initial release:

- `tauri-plugin-content-update`: serves downloaded web bundles through the app's `Assets`
  (`wrap_assets()`), delta downloads with resume and verification, trial activation with automatic
  rollback (`notifyReady()`/`readyTimeout`), native compatibility checks (`requires`,
  `minNativeVersion`) before download and at boot, `incompatibleVersion`.
- `tauri-plugin-content-update-build`: native API hashes of the app (commands, capability-allowed
  plugin commands) and typed TypeScript bindings of its commands, from `build.rs`.
- npm `tauri-plugin-content-update`: JS API (`ContentUpdate`, `sync()`), the `content-update` CLI
  (`bundle`, `bindings`) and the bundler as a library.
