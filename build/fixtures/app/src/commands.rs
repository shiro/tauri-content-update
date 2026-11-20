use serde::Serialize;
use tauri::{AppHandle, Runtime};

/// What the native side of the app reports about itself.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    /// the app version (`version` in tauri.conf.json)
    pub version: String,
    /// `android`, `linux`, `macos`, `windows`, `ios`
    pub platform: String,
}

/// The app's version and platform.
#[tauri::command]
pub fn app_info<R: Runtime>(app: AppHandle<R>) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        platform: std::env::consts::OS.into(),
    }
}
