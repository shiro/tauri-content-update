mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut context = tauri::generate_context!();
    // serves the active content-update bundle, the embedded assets are the built-in one
    tauri_plugin_content_update::wrap_assets(&mut context);
    tauri::Builder::default()
        // rust `log` output (incl. the content-update plugin's) to stdout, logcat on android
        .plugin(
            tauri_plugin_log::Builder::new()
                .clear_targets()
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::Stdout,
                ))
                .level(log::LevelFilter::Info)
                .build(),
        )
        // the native API this build provides (build.rs): bundles needing more aren't installed
        .plugin(tauri_plugin_content_update::init(
            tauri_plugin_content_update::native_api!(),
        ))
        // the frontend calls these through the generated bindings (src/native.gen.ts)
        .invoke_handler(tauri::generate_handler![commands::app_info])
        .run(context)
        .expect("error while running tauri application");
}
