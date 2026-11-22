fn main() {
    tauri_build::build();
    // after tauri_build: hashes the native API this build provides (app commands + the plugin
    // commands the capabilities allow) for the content-update plugin, and generates the typed bindings
    // the frontend calls the app's commands with
    tauri_plugin_content_update_build::Builder::new()
        .bindings("../src/native.gen.ts")
        .build();
}
