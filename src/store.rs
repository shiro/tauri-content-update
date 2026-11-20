use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
    thread,
    time::{Duration, Instant, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::{
    assets::SHARED,
    error::{Error, Result},
    manifest::{self, Entry, Manifest, META},
    Config,
};

const MAX_MANIFEST_BYTES: u64 = 16 << 20;
const MAX_FAILED: usize = 20;
pub const EVENT_PROGRESS: &str = "content-update://download-progress";
pub const EVENT_ROLLBACK: &str = "content-update://rollback";

/// the persisted state (`<app data>/content-update/state.json`)
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Persisted {
    /// identity of the native binary the state belongs to, a new one resets everything
    binary: Option<String>,
    /// active bundle version, `None` = built-in
    current: Option<String>,
    /// last known-good bundle while the current one is on trial, `None` = built-in
    previous: Option<String>,
    /// the current bundle hasn't called notifyReady yet
    trial: bool,
    /// staged bundle, activated on the next launch (or apply()), `""` = built-in
    next: Option<String>,
    failed: Vec<String>,
    /// the last published version seen that this app can't run: the app should be updated
    incompatible: Option<String>,
}

/// The plugin's state, managed by the app.
pub struct ContentUpdate<R: Runtime> {
    app: AppHandle<R>,
    config: Config,
    root: PathBuf,
    bundles: PathBuf,
    staging: PathBuf,
    state_file: PathBuf,
    builtin: Option<Manifest>,
    native_version_code: u64,
    /// hashes of the native API the app provides
    native_api: HashSet<&'static str>,
    state: Mutex<Persisted>,
    downloading: AtomicBool,
    /// invalidates pending ready timers
    timer: AtomicU64,
}

/// the boot logic (trial rollback, promoting the staged bundle) runs once per process
static BOOTED: AtomicBool = AtomicBool::new(false);

impl<R: Runtime> ContentUpdate<R> {
    pub fn new(
        app: AppHandle<R>,
        config: Config,
        native_api: &'static [&'static str],
    ) -> Result<Self> {
        let root = app
            .path()
            .app_data_dir()
            .map_err(|e| Error::Io(std::io::Error::other(e.to_string())))?
            .join("content-update");
        let builtin = SHARED.embedded(&format!("/{META}")).and_then(|raw| {
            let raw = String::from_utf8(raw).ok()?;
            Manifest::parse(&raw)
                .map_err(|e| {
                    log::warn!("unusable built-in {META} ({e}), files can't be reused from the app")
                })
                .ok()
        });
        if SHARED.wrapped() && builtin.is_none() {
            log::warn!("the built-in bundle has no {META} (run `content-update bundle` before building the app)");
        }
        let native_version_code = native_version_code(&app);
        let state = read_state(&root.join("state.json"));
        let lu = ContentUpdate {
            bundles: root.join("bundles"),
            staging: root.join("staging"),
            state_file: root.join("state.json"),
            root,
            config,
            builtin,
            native_version_code,
            native_api: native_api.iter().copied().collect(),
            state: Mutex::new(state),
            downloading: AtomicBool::new(false),
            timer: AtomicU64::new(0),
            app,
        };
        if !BOOTED.swap(true, Ordering::SeqCst) {
            lu.boot()?;
        }
        SHARED.set_active(lu.active_dir(&lu.state.lock().unwrap()));
        Ok(lu)
    }

    // ---------------------------------------------------------------------------------------------
    // state machine

    fn boot(&self) -> Result<()> {
        let mut s = self.state.lock().unwrap();
        let binary = binary_id();
        if s.binary.as_deref() != Some(&binary) {
            // fresh install or a new binary: its built-in bundle wins, drop everything downloaded
            if s.binary.is_some() {
                log::info!("native binary changed, resetting to the built-in bundle");
            }
            let _ = fs::remove_dir_all(&self.root);
            *s = Persisted {
                binary: Some(binary),
                ..Default::default()
            };
            return self.save(&s);
        }

        if s.trial {
            // the previous process ran the bundle but never got notifyReady (crash, killed, hung)
            let failed = rollback(&mut s);
            log::warn!(
                "bundle {failed:?} was never marked ready, rolled back to {}",
                describe_current(&s)
            );
        }
        // everything this binary would serve is checked against its native API before the webview
        // loads anything, not when the bundle calls into it
        if let Some(next) = s.next.clone() {
            if next.is_empty() || (self.is_installed(&next) && self.runnable_on_boot(&mut s, &next))
            {
                promote(&mut s, &next);
                log::info!("activated staged bundle {}", describe_current(&s));
            } else {
                s.next = None;
            }
        }
        if let Some(current) = s.current.clone() {
            if !self.is_installed(&current) {
                log::error!("bundle {current} is missing, falling back to the built-in bundle");
                s.current = None;
                s.previous = None;
                s.trial = false;
            } else if !self.runnable_on_boot(&mut s, &current) {
                s.current = None;
                s.previous = None;
                s.trial = false;
            }
        }
        self.save(&s)?;
        if s.trial {
            self.start_ready_timer();
        }
        drop(s);
        // synchronous: the plugin state isn't managed yet, so no background thread can look it up
        self.cleanup();
        Ok(())
    }

    fn save(&self, s: &Persisted) -> Result<()> {
        fs::create_dir_all(&self.root)?;
        let tmp = self.state_file.with_extension("json.tmp");
        let mut f = fs::File::create(&tmp)?;
        f.write_all(&serde_json::to_vec_pretty(s).unwrap())?;
        f.sync_all()?;
        fs::rename(&tmp, &self.state_file)?;
        Ok(())
    }

    fn active_dir(&self, s: &Persisted) -> Option<PathBuf> {
        s.current.as_ref().map(|v| self.bundles.join(v))
    }

    fn start_ready_timer(&self) {
        let generation = self.timer.fetch_add(1, Ordering::SeqCst) + 1;
        let app = self.app.clone();
        let timeout = Duration::from_millis(self.config.ready_timeout);
        thread::spawn(move || {
            thread::sleep(timeout);
            let Some(lu) = app.try_state::<ContentUpdate<R>>() else {
                return;
            };
            if lu.timer.load(Ordering::SeqCst) == generation {
                lu.on_ready_timeout();
            }
        });
    }

    fn cancel_ready_timer(&self) {
        self.timer.fetch_add(1, Ordering::SeqCst);
    }

    fn on_ready_timeout(&self) {
        let (failed, version) = {
            let mut s = self.state.lock().unwrap();
            if !s.trial {
                return;
            }
            let failed = rollback(&mut s);
            log::warn!(
                "bundle {failed:?} did not call notifyReady within {}ms, rolled back to {}",
                self.config.ready_timeout,
                describe_current(&s)
            );
            if let Err(e) = self.save(&s) {
                log::error!("can't save the content-update state: {e}");
            }
            self.apply_to_webviews(&s);
            (failed, self.version_of(s.current.as_deref()))
        };
        let _ = self.app.emit(
            EVENT_ROLLBACK,
            json!({ "failedVersion": failed, "version": version }),
        );
        self.spawn_cleanup();
    }

    /// switches the asset provider to the current bundle and reloads the webviews
    fn apply_to_webviews(&self, s: &Persisted) {
        SHARED.set_active(self.active_dir(s));
        for (_, window) in self.app.webview_windows() {
            match window.url() {
                Ok(mut url) => {
                    url.set_path("/");
                    url.set_query(None);
                    url.set_fragment(None);
                    if let Err(e) = window.navigate(url) {
                        log::error!("can't reload the webview: {e}");
                    }
                }
                Err(e) => log::error!("can't reload the webview: {e}"),
            }
        }
    }

    fn spawn_cleanup(&self) {
        let app = self.app.clone();
        thread::spawn(move || {
            if let Some(lu) = app.try_state::<ContentUpdate<R>>() {
                lu.cleanup();
            }
        });
    }

    /// deletes installed bundles that aren't referenced anymore
    fn cleanup(&self) {
        let s = self.state.lock().unwrap();
        let keep: HashSet<&str> = [&s.current, &s.previous, &s.next]
            .into_iter()
            .flatten()
            .map(String::as_str)
            .filter(|v| !v.is_empty())
            .collect();
        let Ok(entries) = fs::read_dir(&self.bundles) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !keep.contains(name.as_str()) {
                log::info!("removing unused bundle {name}");
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }

    // ---------------------------------------------------------------------------------------------
    // commands

    pub fn get_state(&self) -> Value {
        self.state_json(&self.state.lock().unwrap())
    }

    pub fn notify_ready(&self) -> Result<Value> {
        let mut s = self.state.lock().unwrap();
        if s.trial {
            self.cancel_ready_timer();
            s.trial = false;
            s.previous = None;
            self.save(&s)?;
            log::info!("bundle {} is ready", describe_current(&s));
            self.spawn_cleanup();
        }
        Ok(self.state_json(&s))
    }

    pub fn check(&self, url: Option<String>) -> Result<Value> {
        let url = self.manifest_url(url)?;
        let (m, _) = fetch_manifest(&url).map_err(Error::CheckFailed)?;
        let mut s = self.state.lock().unwrap();
        let status = self.status(&s, &m);
        self.note_published(&mut s, &m, status)?;
        Ok(self.describe(&s, &m, status))
    }

    pub fn download(&self, url: Option<String>, force: bool) -> Result<Value> {
        let url = self.manifest_url(url)?;
        if self.downloading.swap(true, Ordering::SeqCst) {
            return Err(Error::Busy);
        }
        let result = self.download_inner(&url, force);
        self.downloading.store(false, Ordering::SeqCst);
        result
    }

    fn download_inner(&self, url: &str, force: bool) -> Result<Value> {
        let (m, base) = fetch_manifest(url).map_err(Error::DownloadFailed)?;
        let mut status = {
            let mut s = self.state.lock().unwrap();
            let status = self.status(&s, &m);
            self.note_published(&mut s, &m, status)?;
            status
        };
        if force && status == "failed" {
            status = "available";
        }
        if status != "available" {
            let s = self.state.lock().unwrap();
            return Ok(self.describe(&s, &m, status));
        }

        if self
            .builtin
            .as_ref()
            .is_some_and(|b| b.version == m.version)
        {
            // the server went back to the version shipped in the app
            let mut s = self.state.lock().unwrap();
            stage(&mut s, "");
            self.save(&s)?;
            return Ok(self.describe(&s, &m, "staged"));
        }

        if !self.is_installed_manifest(&m) {
            self.install(&m, &base).map_err(Error::DownloadFailed)?;
        }
        let mut s = self.state.lock().unwrap();
        stage(&mut s, &m.version);
        s.failed.retain(|v| v != &m.version);
        self.save(&s)?;
        Ok(self.describe(&s, &m, "staged"))
    }

    /// activates the staged bundle now (reloads the webviews)
    pub fn apply(&self) -> Result<Value> {
        let mut s = self.state.lock().unwrap();
        let next = s.next.clone().ok_or(Error::NoUpdate)?;
        promote(&mut s, &next);
        self.save(&s)?;
        if s.trial {
            self.start_ready_timer();
        } else {
            self.cancel_ready_timer();
        }
        log::info!("applying bundle {}", describe_current(&s));
        let state = self.state_json(&s);
        self.apply_to_webviews(&s);
        Ok(state)
    }

    /// back to the built-in bundle now (reloads the webviews), forgets failed versions
    pub fn reset(&self) -> Result<Value> {
        let mut s = self.state.lock().unwrap();
        self.cancel_ready_timer();
        s.current = None;
        s.previous = None;
        s.next = None;
        s.failed.clear();
        s.trial = false;
        self.save(&s)?;
        let state = self.state_json(&s);
        self.apply_to_webviews(&s);
        drop(s);
        self.spawn_cleanup();
        Ok(state)
    }

    // ---------------------------------------------------------------------------------------------
    // installing

    /// builds bundles/<version> from local files where possible and downloads the rest
    fn install(&self, m: &Manifest, base: &str) -> std::result::Result<(), String> {
        let io = |e: std::io::Error| e.to_string();
        // a single staging dir is kept between attempts so an interrupted download resumes per file
        if let Ok(entries) = fs::read_dir(&self.staging) {
            for entry in entries.flatten() {
                if entry.file_name().to_string_lossy() != m.version {
                    let _ = fs::remove_dir_all(entry.path());
                }
            }
        }
        let stage = self.staging.join(&m.version);
        fs::create_dir_all(&stage).map_err(io)?;

        let local = self.local_files();
        let mut missing = Vec::new();
        for e in m.files.values() {
            let out = manifest::target(&stage, &e.path)?;
            // files only appear in the staging dir after being verified
            if fs::metadata(&out).is_ok_and(|md| md.is_file() && md.len() == e.size) {
                continue;
            }
            if local
                .get(&e.sha256)
                .is_some_and(|src| src.materialize(&out, e))
            {
                continue;
            }
            missing.push(e.clone());
        }
        let total: u64 = missing.iter().map(|e| e.size).sum();
        log::info!(
            "installing {}: {} local files, downloading {} ({total} bytes)",
            m.version,
            m.files.len() - missing.len(),
            missing.len()
        );
        self.download_files(m, base, missing, &stage, total)?;

        fs::write(stage.join(META), &m.raw).map_err(io)?;
        fs::create_dir_all(&self.bundles).map_err(io)?;
        let _s = self.state.lock().unwrap();
        let dst = self.bundles.join(&m.version);
        if dst.exists() {
            fs::remove_dir_all(&dst).map_err(io)?;
        }
        fs::rename(&stage, &dst).map_err(io)
    }

    fn download_files(
        &self,
        m: &Manifest,
        base: &str,
        files: Vec<Entry>,
        stage: &Path,
        total: u64,
    ) -> std::result::Result<(), String> {
        let total_files = files.len() as u64;
        if files.is_empty() {
            self.progress(&m.version, 0, 0, 0, 0);
            return Ok(());
        }
        let queue = Mutex::new(files.into_iter().collect::<VecDeque<_>>());
        let loaded = AtomicU64::new(0);
        let done = AtomicU64::new(0);
        let cancelled = AtomicBool::new(false);
        let error = Mutex::new(None::<String>);
        // events are read and sent under a lock so they arrive in order (loaded never decreases)
        let events = Mutex::new(Instant::now() - Duration::from_secs(1));
        let emit = |force: bool| {
            let mut last = events.lock().unwrap();
            if force || last.elapsed() >= Duration::from_millis(100) {
                *last = Instant::now();
                let (l, d) = (loaded.load(Ordering::SeqCst), done.load(Ordering::SeqCst));
                self.progress(&m.version, l, total, d, total_files);
            }
        };
        let workers = self.config.concurrency.clamp(1, total_files as usize);
        thread::scope(|scope| {
            for _ in 0..workers {
                scope.spawn(|| loop {
                    if cancelled.load(Ordering::SeqCst) {
                        return;
                    }
                    let Some(e) = queue.lock().unwrap().pop_front() else {
                        return;
                    };
                    let result = manifest::target(stage, &e.path).and_then(|out| {
                        download_file(
                            &format!("{base}files/{}", e.sha256),
                            &e,
                            &out,
                            &cancelled,
                            |n| {
                                loaded.fetch_add(n, Ordering::SeqCst);
                                emit(false);
                            },
                        )
                    });
                    match result {
                        Ok(()) => {
                            done.fetch_add(1, Ordering::SeqCst);
                            emit(true);
                        }
                        Err(err) => {
                            cancelled.store(true, Ordering::SeqCst);
                            error.lock().unwrap().get_or_insert(err);
                            return;
                        }
                    }
                });
            }
        });
        match error.into_inner().unwrap() {
            Some(err) => Err(err),
            None => Ok(()),
        }
    }

    fn progress(&self, version: &str, loaded: u64, total: u64, files: u64, total_files: u64) {
        let _ = self.app.emit(
            EVENT_PROGRESS,
            json!({ "version": version, "loaded": loaded, "total": total, "files": files, "totalFiles": total_files }),
        );
    }

    /// sha256 -> local copy, from the built-in bundle and the installed bundles
    fn local_files(&self) -> HashMap<String, Source> {
        let mut out = HashMap::new();
        if let Some(builtin) = &self.builtin {
            for e in builtin.files.values() {
                out.insert(e.sha256.clone(), Source::Builtin(e.path.clone()));
            }
        }
        // installed files win: hard links are cheaper than copying out of the binary
        let s = self.state.lock().unwrap();
        for v in [&s.previous, &s.current, &s.next].into_iter().flatten() {
            if v.is_empty() {
                continue;
            }
            let Some(bm) = self.read_installed_manifest(v) else {
                continue;
            };
            let dir = self.bundles.join(v);
            for e in bm.files.values() {
                if let Ok(path) = manifest::target(&dir, &e.path) {
                    out.insert(e.sha256.clone(), Source::File(path));
                }
            }
        }
        out
    }

    fn read_installed_manifest(&self, version: &str) -> Option<Manifest> {
        let raw = fs::read_to_string(self.bundles.join(version).join(META)).ok()?;
        Manifest::parse(&raw).ok()
    }

    fn is_installed(&self, version: &str) -> bool {
        let dir = self.bundles.join(version);
        dir.join("index.html").is_file() && dir.join(META).is_file()
    }

    fn is_installed_manifest(&self, m: &Manifest) -> bool {
        self.is_installed(&m.version)
            && self
                .read_installed_manifest(&m.version)
                .is_some_and(|i| i.same_files(m))
    }

    // ---------------------------------------------------------------------------------------------
    // helpers

    /// remembers whether the published version needs a newer app (`incompatibleVersion`)
    fn note_published(&self, s: &mut Persisted, m: &Manifest, status: &str) -> Result<()> {
        let incompatible = (status == "incompatible").then(|| m.version.clone());
        if s.incompatible != incompatible {
            if let (Some(_), Some(reason)) = (&incompatible, self.incompatibility(m)) {
                log::info!(
                    "the published bundle {} can't run on this app ({reason}), the app needs an update",
                    m.version
                );
            }
            s.incompatible = incompatible;
            self.save(s)?;
        }
        Ok(())
    }

    /// Whether this binary can run an installed bundle (its manifest's `minNativeVersion` and
    /// `requires`). Bundles are checked before they're downloaded, so this only fails if the
    /// binary changed without being detected as new; such a bundle is remembered as
    /// `incompatibleVersion` (the app asks for an update) and not served.
    fn runnable_on_boot(&self, s: &mut Persisted, version: &str) -> bool {
        let Some(m) = self.read_installed_manifest(version) else {
            log::error!("bundle {version} has no readable manifest, not serving it");
            return false;
        };
        match self.incompatibility(&m) {
            None => true,
            Some(reason) => {
                log::error!("bundle {version} can't run on this binary ({reason}), not serving it");
                s.incompatible = Some(version.into());
                false
            }
        }
    }

    /// why the app can't run a bundle: `nativeVersion` (its `minNativeVersion` is higher than the
    /// app's version code) or `nativeApi` (it uses native API the app doesn't provide)
    fn incompatibility(&self, m: &Manifest) -> Option<&'static str> {
        if m.min_native_version > self.native_version_code {
            Some("nativeVersion")
        } else if m
            .requires
            .iter()
            .any(|h| !self.native_api.contains(h.as_str()))
        {
            Some("nativeApi")
        } else {
            None
        }
    }

    fn status(&self, s: &Persisted, m: &Manifest) -> &'static str {
        if Some(m.version.as_str()) == self.version_of(s.current.as_deref()).as_deref() {
            return "up-to-date";
        }
        if let Some(next) = &s.next {
            if Some(m.version.as_str()) == self.version_of(Some(next)).as_deref() {
                return "staged";
            }
        }
        if s.failed.contains(&m.version) {
            return "failed";
        }
        if self.incompatibility(m).is_some() {
            return "incompatible";
        }
        "available"
    }

    fn describe(&self, s: &Persisted, m: &Manifest, status: &str) -> Value {
        let mut o = json!({
            "status": status,
            "version": m.version,
            "currentVersion": self.version_of(s.current.as_deref()),
            "minNativeVersion": m.min_native_version,
        });
        if status == "incompatible" {
            o["reason"] = json!(self.incompatibility(m));
        }
        if status == "available" {
            // what a download would fetch over the network (state lock is held: compute inline)
            let mut known: HashSet<String> = self
                .builtin
                .iter()
                .flat_map(|b| b.files.values().map(|e| e.sha256.clone()))
                .collect();
            for v in [&s.previous, &s.current, &s.next].into_iter().flatten() {
                if let Some(bm) = (!v.is_empty())
                    .then(|| self.read_installed_manifest(v))
                    .flatten()
                {
                    known.extend(bm.files.values().map(|e| e.sha256.clone()));
                }
            }
            let missing: Vec<&Entry> = m
                .files
                .values()
                .filter(|e| !known.contains(&e.sha256))
                .collect();
            o["downloadSize"] = json!(missing.iter().map(|e| e.size).sum::<u64>());
            o["downloadFiles"] = json!(missing.len());
        }
        o
    }

    fn state_json(&self, s: &Persisted) -> Value {
        json!({
            "currentVersion": self.version_of(s.current.as_deref()),
            "isBuiltin": s.current.is_none(),
            "builtinVersion": self.builtin.as_ref().map(|b| &b.version),
            "nextVersion": s.next.as_ref().and_then(|n| self.version_of(Some(n))),
            "pendingReady": s.trial,
            "failedVersions": s.failed,
            "incompatibleVersion": s.incompatible,
            "nativeVersionCode": self.native_version_code,
            "manifestUrl": self.config.manifest_url,
        })
    }

    /// the version of a bundle reference (`None`/`""` = built-in)
    fn version_of(&self, bundle: Option<&str>) -> Option<String> {
        match bundle {
            Some(v) if !v.is_empty() => Some(v.to_string()),
            _ => self.builtin.as_ref().map(|b| b.version.clone()),
        }
    }

    fn manifest_url(&self, url: Option<String>) -> Result<String> {
        if !SHARED.wrapped() {
            return Err(Error::NotWrapped);
        }
        url.filter(|u| !u.is_empty())
            .or_else(|| self.config.manifest_url.clone().filter(|u| !u.is_empty()))
            .ok_or(Error::NoUrl)
    }
}

// -------------------------------------------------------------------------------------------------
// state transitions

/// current -> failed, previous -> current. Returns the failed version.
fn rollback(s: &mut Persisted) -> Option<String> {
    let failed = s.current.take();
    if let Some(f) = &failed {
        s.failed.retain(|v| v != f);
        s.failed.push(f.clone());
        let excess = s.failed.len().saturating_sub(MAX_FAILED);
        s.failed.drain(..excess);
    }
    s.current = s.previous.take();
    s.trial = false;
    failed
}

/// makes the staged bundle current (`""` = built-in)
fn promote(s: &mut Persisted, next: &str) {
    s.next = None;
    if next.is_empty() {
        // the built-in bundle is trusted, no trial needed
        s.current = None;
        s.previous = None;
        s.trial = false;
    } else {
        // keep the last known-good bundle if the current one is itself still on trial
        if !s.trial {
            s.previous = s.current.clone();
        }
        s.current = Some(next.into());
        s.trial = true;
    }
}

fn stage(s: &mut Persisted, version: &str) {
    let is_current = if version.is_empty() {
        s.current.is_none()
    } else {
        s.current.as_deref() == Some(version)
    };
    s.next = if is_current {
        None
    } else {
        Some(version.into())
    };
}

fn describe_current(s: &Persisted) -> &str {
    s.current.as_deref().unwrap_or("built-in")
}

fn read_state(file: &Path) -> Persisted {
    fs::read(file)
        .ok()
        .and_then(|data| serde_json::from_slice(&data).ok())
        .unwrap_or_default()
}

// -------------------------------------------------------------------------------------------------
// local files

enum Source {
    /// a file of the built-in bundle
    Builtin(String),
    /// a file of an installed bundle
    File(PathBuf),
}

impl Source {
    fn materialize(&self, out: &Path, e: &Entry) -> bool {
        if let Some(parent) = out.parent() {
            let _ = fs::create_dir_all(parent);
        }
        match self {
            Source::Builtin(path) => match SHARED.embedded(&format!("/{path}")) {
                Some(data) => write_verified(&data[..], out, e),
                None => false,
            },
            Source::File(src) => {
                if !fs::metadata(src).is_ok_and(|m| m.is_file() && m.len() == e.size) {
                    return false;
                }
                let _ = fs::remove_file(out);
                // bundle files are never modified in place, so sharing the inode is safe
                if fs::hard_link(src, out).is_ok() {
                    return true;
                }
                fs::File::open(src).is_ok_and(|f| write_verified(f, out, e))
            }
        }
    }
}

fn write_verified(mut input: impl Read, out: &Path, e: &Entry) -> bool {
    let part = part_path(out);
    let ok = (|| -> std::io::Result<bool> {
        let mut f = fs::File::create(&part)?;
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; 64 << 10];
        let mut size = 0u64;
        loop {
            let n = input.read(&mut buf)?;
            if n == 0 {
                break;
            }
            size += n as u64;
            hasher.update(&buf[..n]);
            f.write_all(&buf[..n])?;
        }
        if size != e.size || hex(&hasher.finalize()) != e.sha256 {
            return Ok(false);
        }
        fs::rename(&part, out)?;
        Ok(true)
    })()
    .unwrap_or(false);
    let _ = fs::remove_file(&part);
    ok
}

// -------------------------------------------------------------------------------------------------
// http

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(15)))
        .timeout_recv_response(Some(Duration::from_secs(30)))
        .http_status_as_error(false)
        .build()
        .into()
}

/// fetches and parses a manifest, returns it with the base url its files are relative to
fn fetch_manifest(url: &str) -> std::result::Result<(Manifest, String), String> {
    let parsed = tauri::Url::parse(url).map_err(|e| format!("invalid url {url}: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("unsupported url: {url}"));
    }
    let mut res = agent()
        .get(url)
        .header("Cache-Control", "no-cache")
        .config()
        .timeout_recv_body(Some(Duration::from_secs(60)))
        .build()
        .call()
        .map_err(|e| format!("{e} ({url})"))?;
    if res.status() != 200 {
        return Err(format!("HTTP {} for {url}", res.status().as_u16()));
    }
    let raw = res
        .body_mut()
        .with_config()
        .limit(MAX_MANIFEST_BYTES)
        .read_to_string()
        .map_err(|e| format!("{e} ({url})"))?;
    let m = Manifest::parse(&raw)?;
    // files are relative to the manifest
    let base = parsed.join("./").map_err(|e| e.to_string())?.to_string();
    Ok((m, base))
}

fn download_file(
    url: &str,
    e: &Entry,
    out: &Path,
    cancelled: &AtomicBool,
    progress: impl Fn(u64),
) -> std::result::Result<(), String> {
    if let Some(parent) = out.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let part = part_path(out);
    let result = (|| {
        // generous for slow networks, but a stalled server can't hang the download forever
        let body_timeout = Duration::from_secs(120).max(Duration::from_millis(e.size / 16));
        let mut res = agent()
            .get(url)
            .config()
            .timeout_recv_body(Some(body_timeout))
            .build()
            .call()
            .map_err(|err| format!("{err} ({url})"))?;
        if res.status() != 200 {
            return Err(format!("HTTP {} for {url}", res.status().as_u16()));
        }
        let mut reader = res.body_mut().with_config().limit(u64::MAX).reader();
        let mut f = fs::File::create(&part).map_err(|e| e.to_string())?;
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; 64 << 10];
        let mut count = 0u64;
        loop {
            let n = reader
                .read(&mut buf)
                .map_err(|err| format!("{err} ({url})"))?;
            if n == 0 {
                break;
            }
            if cancelled.load(Ordering::SeqCst) {
                return Err("cancelled".into());
            }
            count += n as u64;
            if count > e.size {
                return Err(format!(
                    "{} is larger than its declared size {}",
                    e.path, e.size
                ));
            }
            hasher.update(&buf[..n]);
            f.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            progress(n as u64);
        }
        if count != e.size {
            return Err(format!("{} is {count} bytes, expected {}", e.path, e.size));
        }
        if hex(&hasher.finalize()) != e.sha256 {
            return Err(format!("checksum mismatch for {}", e.path));
        }
        f.sync_all().map_err(|e| e.to_string())?;
        fs::rename(&part, out).map_err(|e| e.to_string())
    })();
    let _ = fs::remove_file(&part);
    result
}

fn part_path(out: &Path) -> PathBuf {
    let mut p = out.as_os_str().to_owned();
    p.push(".part");
    PathBuf::from(p)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// -------------------------------------------------------------------------------------------------
// native binary

/// `bundle.android.versionCode`, or the one tauri derives from the app version
/// (major * 1000000 + minor * 1000 + patch), also used on desktop
fn native_version_code<R: Runtime>(app: &AppHandle<R>) -> u64 {
    if let Some(code) = app.config().bundle.android.version_code {
        return code as u64;
    }
    let v = &app.package_info().version;
    v.major * 1_000_000 + v.minor * 1_000 + v.patch
}

/// identifies the installed binary: the path of the module this code is in (on android the
/// `base.apk!/lib/...` path, whose directory changes on every install) plus its file's size and mtime
fn binary_id() -> String {
    let path = module_path().unwrap_or_default();
    let file = path.split('!').next().unwrap_or_default();
    let (size, mtime) = fs::metadata(file)
        .map(|m| {
            let mtime = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_nanos());
            (m.len(), mtime)
        })
        .unwrap_or((0, 0));
    format!("{path}|{size}|{mtime}")
}

#[cfg(unix)]
fn module_path() -> Option<String> {
    let mut info: libc::Dl_info = unsafe { std::mem::zeroed() };
    let addr = binary_id as *const libc::c_void;
    if unsafe { libc::dladdr(addr, &mut info) } == 0 || info.dli_fname.is_null() {
        return std::env::current_exe()
            .ok()
            .map(|p| p.to_string_lossy().into_owned());
    }
    let name = unsafe { std::ffi::CStr::from_ptr(info.dli_fname) };
    let name = name.to_string_lossy().into_owned();
    // on linux the main executable may be reported by its bare name
    if name.contains('/') {
        Some(name)
    } else {
        std::env::current_exe()
            .ok()
            .map(|p| p.to_string_lossy().into_owned())
    }
}

#[cfg(not(unix))]
fn module_path() -> Option<String> {
    std::env::current_exe()
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bundles(s: &Persisted) -> (Option<&str>, Option<&str>, bool) {
        (s.current.as_deref(), s.previous.as_deref(), s.trial)
    }

    #[test]
    fn a_new_bundle_is_on_trial_and_rolls_back_to_the_last_good_one() {
        let mut s = Persisted {
            current: Some("v1".into()),
            ..Default::default()
        };
        promote(&mut s, "v2");
        assert_eq!(bundles(&s), (Some("v2"), Some("v1"), true));
        // applied while v2 is still on trial: v1 stays the known-good fallback
        promote(&mut s, "v3");
        assert_eq!(bundles(&s), (Some("v3"), Some("v1"), true));
        assert_eq!(rollback(&mut s).as_deref(), Some("v3"));
        assert_eq!(bundles(&s), (Some("v1"), None, false));
        assert_eq!(s.failed, ["v3"]);
    }

    #[test]
    fn the_builtin_bundle_needs_no_trial() {
        let mut s = Persisted {
            current: Some("v2".into()),
            previous: Some("v1".into()),
            trial: true,
            next: Some("".into()),
            ..Default::default()
        };
        promote(&mut s, "");
        assert_eq!(bundles(&s), (None, None, false));
        assert_eq!(s.next, None);
    }

    #[test]
    fn failed_versions_are_deduplicated_and_capped() {
        let mut s = Persisted::default();
        for i in 0..MAX_FAILED + 5 {
            s.current = Some(format!("v{i}"));
            rollback(&mut s);
        }
        s.current = Some("v10".into());
        rollback(&mut s);
        assert_eq!(s.failed.len(), MAX_FAILED);
        assert_eq!(s.failed.iter().filter(|v| *v == "v10").count(), 1);
        assert_eq!(s.failed.last().unwrap(), "v10");
    }

    #[test]
    fn staging_the_running_bundle_stages_nothing() {
        let mut s = Persisted {
            current: Some("v1".into()),
            next: Some("v2".into()),
            ..Default::default()
        };
        stage(&mut s, "v1");
        assert_eq!(s.next, None);
        stage(&mut s, "");
        assert_eq!(s.next.as_deref(), Some(""));
        s.current = None;
        stage(&mut s, "");
        assert_eq!(s.next, None);
    }

    #[test]
    fn local_files_are_only_reused_if_they_match() {
        let dir = std::env::temp_dir().join(format!("content-update-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let out = dir.join("a.js");
        let entry = |data: &[u8]| Entry {
            path: "a.js".into(),
            sha256: hex(&Sha256::digest(data)),
            size: data.len() as u64,
        };
        assert!(!write_verified(&b"evil"[..], &out, &entry(b"good")));
        assert!(!write_verified(&b"good!"[..], &out, &entry(b"good")));
        assert!(!out.exists() && !part_path(&out).exists());
        assert!(write_verified(&b"good"[..], &out, &entry(b"good")));
        assert_eq!(fs::read(&out).unwrap(), b"good");
        fs::remove_dir_all(&dir).unwrap();
    }
}
