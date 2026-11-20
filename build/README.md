# tauri-plugin-content-update-build

Build-time helper of [`tauri-plugin-content-update`](../README.md), used from the app's `build.rs`:

```rust
fn main() {
    tauri_build::build();
    // after tauri_build, which resolves the plugins' permissions
    tauri_plugin_content_update_build::Builder::new()
        .bindings("../src/native.gen.ts")
        .build();
}
```

It hashes the native API the app provides (its commands with their signatures, and the plugin
commands its capabilities allow), which the plugin gets through
`tauri_plugin_content_update::native_api!()`, and generates typed TypeScript bindings of the app's
commands. See the main README for the details.
