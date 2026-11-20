//! Over-the-air updates of a Tauri app's web bundle.
//!
//! A bundle is published as a static folder: `manifest.json` (version + every file's sha256/size)
//! next to content-addressed `files/<sha256>` blobs. Updating only downloads files that aren't on
//! the device yet (in the app's embedded bundle or an installed bundle); everything else is
//! hard-linked/copied locally.
//!
//! The active bundle is served by wrapping the app's [`tauri::Assets`] provider
//! ([`wrap_assets`]), so tauri's own protocol handler (mime types, SPA fallback, CSP) keeps
//! working and the embedded assets stay the built-in bundle.
//!
//! A newly activated bundle is on trial until the web app calls `notifyReady()`. If it doesn't
//! within `readyTimeout` ms, or the process dies first, the previous bundle is restored and the
//! version is remembered as failed (and not installed again unless forced).
//!
//! A bundle is only installed if the app can run it: its `minNativeVersion` must not be above the
//! app's version code, and the app must provide every native API (command, plugin command and
//! permission) the bundle uses. The app's native API is computed at build time by
//! `tauri-plugin-content-update-build` and passed to [`init`] with [`native_api!`].

use serde::Deserialize;
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

mod assets;
mod commands;
mod error;
mod manifest;
mod store;

pub use assets::wrap_assets;
pub use error::{Error, Result};
pub use store::ContentUpdate;

/// `plugins > content-update` in `tauri.conf.json`
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    /// manifest url used when `check`/`download` get none
    pub manifest_url: Option<String>,
    /// ms a new bundle has to call `notifyReady()` before it's rolled back
    pub ready_timeout: u64,
    /// parallel file downloads
    pub concurrency: usize,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            manifest_url: None,
            ready_timeout: 10_000,
            concurrency: 4,
        }
    }
}

/// The native API hashes `tauri_plugin_content_update_build::Builder::build()` wrote in the app's `build.rs`,
/// as a `&'static [&'static str]`, for [`init`].
#[macro_export]
macro_rules! native_api {
    () => {
        include!(concat!(env!("OUT_DIR"), "/content-update-native-api.rs"))
    };
}

/// The plugin. `native_api` is what the app provides ([`native_api!`]), bundles needing more aren't
/// installed. The app must also call [`wrap_assets`] on its context.
pub fn init<R: Runtime>(native_api: &'static [&'static str]) -> TauriPlugin<R, Option<Config>> {
    Builder::<R, Option<Config>>::new("content-update")
        .invoke_handler(tauri::generate_handler![
            commands::get_state,
            commands::notify_ready,
            commands::check,
            commands::download,
            commands::apply,
            commands::reset,
        ])
        .setup(move |app, api| {
            if !assets::SHARED.wrapped() {
                log::error!("tauri_plugin_content_update::wrap_assets() was not called, content updates are disabled");
            }
            let config = api.config().clone().unwrap_or_default();
            app.manage(ContentUpdate::new(app.clone(), config, native_api)?);
            Ok(())
        })
        .build()
}
