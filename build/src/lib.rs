//! Build-time helper of `tauri-plugin-content-update`: describes the native API an app provides, so the
//! plugin only installs web bundles that the installed app can run.
//!
//! The native API is a set of short hashes, one per thing the frontend can call:
//! - every app command registered with `generate_handler!`, hashed with its signature: the command
//!   name, the argument keys and the wire shape (serde) of the argument, result and error types;
//! - every plugin command a capability allows (`plugin:<plugin>|<command>`), resolved from the
//!   app's capabilities like tauri does, so a missing plugin or permission counts as missing too.
//!
//! Call [`Builder::build`] from the app's `build.rs`, after `tauri_build::build()`. It
//! - writes typed TypeScript bindings of the app's commands ([`Builder::bindings`]); each binding
//!   carries its hash, which is how `content-update bundle` finds the native API a bundle needs;
//! - writes the hashes to `$OUT_DIR`, the app passes them to the plugin with
//!   `tauri_plugin_content_update::init(tauri_plugin_content_update::native_api!())`;
//! - outside of `tauri dev`, fails the build if the embedded web bundle needs native API this
//!   build doesn't provide (e.g. bindings that were stale when the frontend was built).
//!
//! The hashes are truncated sha256 digests: a manifest lists which ones a bundle needs without
//! naming the commands or describing their types.

use std::{
    collections::{BTreeMap, BTreeSet},
    env, fs,
    path::{Path, PathBuf},
};

use sha2::{Digest, Sha256};
use tauri_utils::{
    acl::{manifest::Manifest, resolved::Resolved, ExecutionContext},
    config::{Config, FrontendDist},
    platform::Target,
};

mod rust;

pub use rust::{analyze, scan, Api, Command};

/// hex characters of a hash
pub const HASH_LEN: usize = 12;
/// the file `$OUT_DIR/<NATIVE_API_FILE>` holds the provided hashes as a `&[&str]` expression
pub const NATIVE_API_FILE: &str = "content-update-native-api.rs";
/// prefix of the ids in the bindings: `native-api:<command>:<hash>`
pub const MARKER: &str = "native-api";

/// The hash of a native API id: a command signature or `plugin:<plugin>|<command>`.
pub fn hash(id: &str) -> String {
    let digest = Sha256::digest(id.as_bytes());
    digest
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>()[..HASH_LEN]
        .to_string()
}

#[derive(Debug, Default)]
pub struct Builder {
    bindings: Option<PathBuf>,
}

impl Builder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Writes TypeScript bindings of the app's commands to `path` (relative to the app crate).
    /// The frontend must call the commands through them: that's how `content-update bundle` sees
    /// which commands a bundle uses.
    pub fn bindings(mut self, path: impl Into<PathBuf>) -> Self {
        self.bindings = Some(path.into());
        self
    }

    /// Runs the helper, panics with a readable message on errors.
    pub fn build(self) {
        if let Err(e) = self.try_build() {
            panic!("\n\ntauri-plugin-content-update-build: {e}\n\n");
        }
    }

    pub fn try_build(self) -> Result<(), String> {
        let crate_dir = PathBuf::from(var("CARGO_MANIFEST_DIR")?);
        let out_dir = PathBuf::from(var("OUT_DIR")?);
        let target = Target::from_triple(&var("TARGET")?);

        let src = crate_dir.join("src");
        println!("cargo:rerun-if-changed={}", src.display());
        let api = scan(&src)?;

        // hash -> id, for messages
        let mut provided = BTreeMap::new();
        for c in &api.commands {
            provided.insert(hash(&c.signature), c.name.clone());
        }

        // known ids, to name the hashes a bundle needs but this build doesn't provide
        let mut known = BTreeMap::new();
        if let Some(path) = &self.bindings {
            let path = crate_dir.join(path);
            println!("cargo:rerun-if-changed={}", path.display());
            let old = fs::read_to_string(&path).unwrap_or_default();
            for (name, h) in markers(&old) {
                known.insert(h, format!("{name} (a stale binding)"));
            }
            let new = render(&api);
            if old != new {
                if let Some(dir) = path.parent() {
                    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
                }
                fs::write(&path, new).map_err(|e| format!("{}: {e}", path.display()))?;
            }
        }

        let config = read_config(&crate_dir, target)?;
        let (allowed, all) = plugin_commands(&config, &out_dir, target)?;
        for id in all {
            known.insert(hash(&id), format!("{id} (not allowed by a capability)"));
        }
        for id in allowed {
            provided.insert(hash(&id), id);
        }

        let list: String = provided.keys().map(|h| format!("    {h:?},\n")).collect();
        write_if_changed(
            &out_dir.join(NATIVE_API_FILE),
            &format!("// generated by tauri-plugin-content-update-build\n&[\n{list}]\n"),
        )?;

        if env::var("DEP_TAURI_DEV").as_deref() != Ok("true") {
            if let Some(FrontendDist::Directory(dir)) = &config.build.frontend_dist {
                check_builtin(&crate_dir.join(dir), &provided, &known, &self.bindings)?;
            }
        }
        Ok(())
    }
}

fn var(name: &str) -> Result<String, String> {
    env::var(name).map_err(|_| format!("{name} is not set (call this from build.rs)"))
}

fn write_if_changed(path: &Path, content: &str) -> Result<(), String> {
    if fs::read_to_string(path).ok().as_deref() != Some(content) {
        fs::write(path, content).map_err(|e| format!("{}: {e}", path.display()))?;
    }
    Ok(())
}

/// `(command, hash)` of the `native-api:<command>:<hash>` ids in a text
pub fn markers(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let prefix = format!("{MARKER}:");
    let mut rest = text;
    while let Some(i) = rest.find(&prefix) {
        rest = &rest[i + prefix.len()..];
        let name: String = rest
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
            .collect();
        let after = &rest[name.len()..];
        if let Some(h) = after.strip_prefix(':') {
            let h: String = h.chars().take_while(|c| c.is_ascii_hexdigit()).collect();
            if h.len() == HASH_LEN && !name.is_empty() {
                out.push((name, h));
            }
        }
    }
    out
}

// -------------------------------------------------------------------------------------------------
// bindings

/// the typescript bindings file. `content-update bindings` (lib/bindings.mjs, a JS port of `scan` and
/// `render`) generates the same file before the frontend is built: keep both in sync, the
/// `fixtures` test and lib/bindings.test.mjs check them against the same expected files.
pub fn render(api: &Api) -> String {
    let mut out = String::from(
        "// Generated from the app's tauri commands by tauri-plugin-content-update (build.rs or `content-update bindings`), do not edit.\n\
         // The `native-api:<command>:<hash>` ids tell `content-update bundle` which native API a web bundle uses.\n",
    );
    let imports = if api.uses_channel {
        "Channel, invoke"
    } else {
        "invoke"
    };
    out.push_str(&format!(
        "import {{ {imports} }} from \"@tauri-apps/api/core\";\n\n"
    ));
    out.push_str(
        "function call<T>(id: string, args?: Record<string, unknown>): Promise<T> {\n  \
         return invoke<T>(id.split(\":\")[1], args);\n}\n",
    );
    for decl in api.types.values() {
        out.push('\n');
        out.push_str(decl);
    }
    for c in &api.commands {
        let params: Vec<String> = c
            .args
            .iter()
            .map(|(_, param, ty)| format!("{param}: {ty}"))
            .collect();
        let fields: Vec<String> = c
            .args
            .iter()
            .map(|(key, param, _)| {
                if key == param {
                    key.clone()
                } else {
                    format!("{key}: {param}")
                }
            })
            .collect();
        let args = if fields.is_empty() {
            String::new()
        } else {
            format!(", {{ {} }}", fields.join(", "))
        };
        out.push('\n');
        out.push_str(&rust::jsdoc(&c.docs, ""));
        out.push_str(&format!(
            "export function {}({}): Promise<{}> {{\n  return call<{}>(\"{MARKER}:{}:{}\"{args});\n}}\n",
            rust::rename("camelCase", &c.name, false),
            params.join(", "),
            c.ret,
            c.ret,
            c.name,
            hash(&c.signature),
        ));
    }
    out
}

// -------------------------------------------------------------------------------------------------
// plugin commands

/// tauri.conf.json (+ the platform config and the CLI's `--config`), like tauri-build reads it
fn read_config(crate_dir: &Path, target: Target) -> Result<Config, String> {
    let (mut config, files) = tauri_utils::config::parse::read_from(target, crate_dir)
        .map_err(|e| format!("can't read the tauri config: {e}"))?;
    for f in files {
        println!("cargo:rerun-if-changed={}", f.display());
    }
    println!("cargo:rerun-if-env-changed=TAURI_CONFIG");
    if let Ok(patch) = env::var("TAURI_CONFIG") {
        let patch = serde_json::from_str(&patch).map_err(|e| format!("TAURI_CONFIG: {e}"))?;
        merge(&mut config, patch);
    }
    serde_json::from_value(config).map_err(|e| format!("invalid tauri config: {e}"))
}

/// JSON merge patch (RFC 7396)
fn merge(target: &mut serde_json::Value, patch: serde_json::Value) {
    match patch {
        serde_json::Value::Object(patch) => {
            if !target.is_object() {
                *target = serde_json::Value::Object(Default::default());
            }
            let map = target.as_object_mut().unwrap();
            for (k, v) in patch {
                if v.is_null() {
                    map.remove(&k);
                } else {
                    merge(map.entry(k).or_insert(serde_json::Value::Null), v);
                }
            }
        }
        patch => *target = patch,
    }
}

/// `(allowed, all)` plugin command ids (`plugin:<plugin>|<command>`): the ones the app's
/// capabilities allow for local (bundled) content on this target, and every one of the installed
/// plugins
fn plugin_commands(
    config: &Config,
    out_dir: &Path,
    target: Target,
) -> Result<(BTreeSet<String>, BTreeSet<String>), String> {
    // written by tauri_build::build()
    let path = out_dir.join(tauri_utils::acl::ACL_MANIFESTS_FILE_NAME);
    let raw = fs::read_to_string(&path).map_err(|e| {
        format!(
            "{}: {e} (call tauri_build::build() before tauri_plugin_content_update_build)",
            path.display()
        )
    })?;
    let acl: BTreeMap<String, Manifest> =
        serde_json::from_str(&raw).map_err(|e| format!("{}: {e}", path.display()))?;

    let from_files = tauri_utils::acl::build::parse_capabilities("./capabilities/**/*")
        .map_err(|e| format!("can't read the capabilities: {e}"))?;
    let capabilities = tauri_utils::acl::get_capabilities(config, from_files, None)
        .map_err(|e| format!("can't resolve the capabilities: {e}"))?;
    let resolved = Resolved::resolve(&acl, capabilities, target)
        .map_err(|e| format!("can't resolve the ACL: {e}"))?;

    let local = |commands: &BTreeMap<String, Vec<tauri_utils::acl::resolved::ResolvedCommand>>| {
        commands
            .iter()
            .filter(|(id, list)| {
                id.starts_with("plugin:")
                    && list
                        .iter()
                        .any(|c| matches!(c.context, ExecutionContext::Local))
            })
            .map(|(id, _)| id.clone())
            .collect::<BTreeSet<_>>()
    };
    let denied = local(&resolved.denied_commands);
    let allowed = local(&resolved.allowed_commands)
        .into_iter()
        .filter(|id| !denied.contains(id))
        .collect();

    let mut all = BTreeSet::new();
    for (key, manifest) in &acl {
        let plugin = key.strip_prefix("core:").unwrap_or(key);
        for p in manifest.permissions.values() {
            for c in p.commands.allow.iter().chain(&p.commands.deny) {
                all.insert(format!("plugin:{plugin}|{c}"));
            }
        }
    }
    Ok((allowed, all))
}

// -------------------------------------------------------------------------------------------------
// the embedded bundle

fn check_builtin(
    dist: &Path,
    provided: &BTreeMap<String, String>,
    known: &BTreeMap<String, String>,
    bindings: &Option<PathBuf>,
) -> Result<(), String> {
    let meta = dist.join("content-update.json");
    println!("cargo:rerun-if-changed={}", meta.display());
    let Ok(raw) = fs::read_to_string(&meta) else {
        // the plugin warns at runtime, `content-update bundle` wasn't run
        return Ok(());
    };
    let manifest: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("{}: {e}", meta.display()))?;
    let missing: Vec<String> = manifest["requires"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|h| h.as_str())
        .filter(|h| !provided.contains_key(*h))
        .map(|h| match known.get(h) {
            Some(id) => format!("{h} = {id}"),
            None => h.to_string(),
        })
        .collect();
    if missing.is_empty() {
        return Ok(());
    }
    Err(format!(
        "the web bundle in {} needs native API this build doesn't provide:\n  {}\n\
         Plugin commands must be allowed by a capability (capabilities/). App commands are called \
         through the generated bindings{}: run `content-update bindings` before the web build \
         (in `beforeBuildCommand`), or regenerate them and rebuild the web bundle.",
        dist.display(),
        missing.join("\n  "),
        bindings
            .as_ref()
            .map(|b| format!(" ({})", b.display()))
            .unwrap_or_default(),
    ))
}

#[cfg(test)]
mod tests;
