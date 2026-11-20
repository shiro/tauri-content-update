mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut context = tauri::generate_context!();
    // serves the active downloaded bundle, the embedded assets are the built-in one
    tauri_plugin_content_update::wrap_assets(&mut context);
    tauri::Builder::default()
        // the native API this build provides (build.rs): bundles needing more aren't installed
        .plugin(tauri_plugin_content_update::init(
            tauri_plugin_content_update::native_api!(),
        ))
        // the frontend calls these through the generated bindings
        .invoke_handler(tauri::generate_handler![commands::app_info])
        .run(context)
        .expect("error while running tauri application");
}
