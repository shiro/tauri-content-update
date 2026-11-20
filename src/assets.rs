//! The asset provider: serves the active downloaded bundle from disk, the embedded (built-in) bundle
//! otherwise. Installed with [`crate::wrap_assets`], which keeps the context's original provider.

use std::{
    borrow::Cow,
    path::PathBuf,
    sync::{Arc, OnceLock, RwLock},
};

use tauri::{
    utils::assets::{AssetKey, AssetsIter, CspHash},
    App, Assets, Context, Runtime,
};

use crate::manifest::{self, META};

type EmbeddedGet = Arc<dyn Fn(&str) -> Option<Vec<u8>> + Send + Sync>;

/// process-wide state shared by the asset provider (created before the app) and the plugin
pub(crate) struct Shared {
    /// reads a file of the built-in bundle (path relative to its root)
    embedded: OnceLock<EmbeddedGet>,
    /// directory of the active downloaded bundle, `None` = the built-in bundle
    active: RwLock<Option<PathBuf>>,
}

pub(crate) static SHARED: Shared = Shared {
    embedded: OnceLock::new(),
    active: RwLock::new(None),
};

impl Shared {
    pub fn wrapped(&self) -> bool {
        self.embedded.get().is_some()
    }

    /// a file of the built-in bundle
    pub fn embedded(&self, path: &str) -> Option<Vec<u8>> {
        self.embedded.get().and_then(|get| get(path))
    }

    pub fn set_active(&self, dir: Option<PathBuf>) {
        *self.active.write().unwrap() = dir;
    }

    fn active(&self) -> Option<PathBuf> {
        self.active.read().unwrap().clone()
    }
}

/// Replaces the context's asset provider with one that serves the active content-update bundle and
/// falls back to the original (embedded) assets for the built-in bundle.
///
/// Plugins can't change the [`Context`], so this has to be called by the app:
/// ```ignore
/// let mut context = tauri::generate_context!();
/// tauri_plugin_content_update::wrap_assets(&mut context);
/// tauri::Builder::default()
///     .plugin(tauri_plugin_content_update::init(tauri_plugin_content_update::native_api!()))
///     .run(context)
///     .expect("error while running tauri application");
/// ```
pub fn wrap_assets<R: Runtime>(context: &mut Context<R>) {
    let embedded: Arc<dyn Assets<R>> = Arc::from(context.set_assets(Box::new(Placeholder)));
    let get = embedded.clone();
    let _ = SHARED.embedded.set(Arc::new(move |path: &str| {
        get.get(&AssetKey::from(path)).map(Cow::into_owned)
    }));
    context.set_assets(Box::new(ContentUpdateAssets { embedded }));
}

struct ContentUpdateAssets<R: Runtime> {
    embedded: Arc<dyn Assets<R>>,
}

impl<R: Runtime> Assets<R> for ContentUpdateAssets<R> {
    fn setup(&self, app: &App<R>) {
        self.embedded.setup(app);
    }

    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        let Some(dir) = SHARED.active() else {
            return self.embedded.get(key);
        };
        // a downloaded bundle is complete, nothing falls through to the embedded assets
        let path = key.as_ref().trim_start_matches('/');
        if path == META {
            return std::fs::read(dir.join(META)).ok().map(Cow::Owned);
        }
        let file = manifest::target(&dir, path).ok()?;
        std::fs::read(file).ok().map(Cow::Owned)
    }

    fn iter(&self) -> Box<AssetsIter<'_>> {
        let Some(dir) = SHARED.active() else {
            return self.embedded.iter();
        };
        let mut files = Vec::new();
        walk(&dir, "", &mut files);
        Box::new(files.into_iter().filter_map(move |rel| {
            let data = std::fs::read(dir.join(&rel)).ok()?;
            Some((Cow::Owned(format!("/{rel}")), Cow::Owned(data)))
        }))
    }

    fn csp_hashes(&self, html_path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        // the hashes are computed at compile time for the embedded html only
        if SHARED.active().is_some() {
            Box::new(std::iter::empty())
        } else {
            self.embedded.csp_hashes(html_path)
        }
    }
}

fn walk(dir: &std::path::Path, prefix: &str, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let rel = if prefix.is_empty() {
            name
        } else {
            format!("{prefix}/{name}")
        };
        match entry.file_type() {
            Ok(t) if t.is_dir() => walk(&entry.path(), &rel, out),
            Ok(t) if t.is_file() => out.push(rel),
            _ => {}
        }
    }
}

/// only held while swapping the providers in [`wrap_assets`]
struct Placeholder;

impl<R: Runtime> Assets<R> for Placeholder {
    fn get(&self, _: &AssetKey) -> Option<Cow<'_, [u8]>> {
        None
    }

    fn iter(&self) -> Box<AssetsIter<'_>> {
        Box::new(std::iter::empty())
    }

    fn csp_hashes(&self, _: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        Box::new(std::iter::empty())
    }
}
