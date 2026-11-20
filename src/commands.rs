use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime};

use crate::{error::Result, ContentUpdate};

// the commands take the AppHandle (not State<ContentUpdate<R>>) so the runtime type can be inferred

#[tauri::command]
pub fn get_state<R: Runtime>(app: AppHandle<R>) -> Value {
    app.state::<ContentUpdate<R>>().get_state()
}

#[tauri::command]
pub fn notify_ready<R: Runtime>(app: AppHandle<R>) -> Result<Value> {
    app.state::<ContentUpdate<R>>().notify_ready()
}

/// fetches the manifest, downloads nothing
#[tauri::command]
pub async fn check<R: Runtime>(app: AppHandle<R>, url: Option<String>) -> Result<Value> {
    blocking(app, move |lu| lu.check(url)).await
}

/// downloads (only the files not on the device yet) and stages the published version
#[tauri::command]
pub async fn download<R: Runtime>(
    app: AppHandle<R>,
    url: Option<String>,
    force: Option<bool>,
) -> Result<Value> {
    blocking(app, move |lu| lu.download(url, force.unwrap_or(false))).await
}

/// activates the staged version now (reloads the webviews)
#[tauri::command]
pub fn apply<R: Runtime>(app: AppHandle<R>) -> Result<Value> {
    app.state::<ContentUpdate<R>>().apply()
}

/// back to the built-in bundle now (reloads the webviews), forgets failed versions
#[tauri::command]
pub fn reset<R: Runtime>(app: AppHandle<R>) -> Result<Value> {
    app.state::<ContentUpdate<R>>().reset()
}

/// network and file work runs on the blocking pool, not on an async worker
async fn blocking<R: Runtime>(
    app: AppHandle<R>,
    f: impl FnOnce(&ContentUpdate<R>) -> Result<Value> + Send + 'static,
) -> Result<Value> {
    tauri::async_runtime::spawn_blocking(move || f(&app.state::<ContentUpdate<R>>()))
        .await
        .map_err(|e| crate::Error::Io(std::io::Error::other(e.to_string())))?
}
