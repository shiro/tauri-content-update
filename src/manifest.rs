use std::{collections::BTreeMap, path::Path};

/// bundle metadata file, at the root of every bundle (the built-in one included)
pub const META: &str = "content-update.json";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub path: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Clone)]
pub struct Manifest {
    pub version: String,
    pub min_native_version: u64,
    /// hashes of the native API the bundle uses (see `tauri-plugin-content-update-build`)
    pub requires: Vec<String>,
    pub files: BTreeMap<String, Entry>,
    /// the manifest as received, stored as the bundle's `content-update.json`
    pub raw: String,
}

pub fn valid_version(v: &str) -> bool {
    let mut chars = v.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphanumeric())
        && v.len() <= 64
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn hex(s: &str) -> bool {
    s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn valid_sha256(s: &str) -> bool {
    s.len() == 64 && hex(s)
}

/// a native API hash (12 characters today, a range so the length can change)
fn valid_api_hash(s: &str) -> bool {
    (8..=64).contains(&s.len()) && hex(s)
}

/// a relative `/`-separated path that stays inside the bundle directory
pub fn check_path(path: &str) -> Result<(), String> {
    let invalid = || Err(format!("invalid path in manifest: {path}"));
    if path.is_empty()
        || path.len() > 1024
        || path.starts_with('/')
        || path.contains('\\')
        || path.contains('\0')
    {
        return invalid();
    }
    if path
        .split('/')
        .any(|s| s.is_empty() || s == "." || s == "..")
    {
        return invalid();
    }
    // a drive prefix (`C:`) would make the path absolute when joined on windows
    if path.split('/').next().is_some_and(|s| s.contains(':')) {
        return invalid();
    }
    if path == META {
        return Err(format!("reserved path in manifest: {path}"));
    }
    Ok(())
}

/// joins a checked manifest path below `dir`
pub fn target(dir: &Path, path: &str) -> Result<std::path::PathBuf, String> {
    check_path(path)?;
    Ok(path.split('/').fold(dir.to_path_buf(), |p, s| p.join(s)))
}

impl Manifest {
    pub fn parse(raw: &str) -> Result<Self, String> {
        let value: serde_json::Value =
            serde_json::from_str(raw).map_err(|e| format!("invalid manifest: {e}"))?;
        let o = value.as_object().ok_or("invalid manifest: not an object")?;
        let version = o.get("version").and_then(|v| v.as_str()).unwrap_or("");
        if !valid_version(version) {
            return Err(format!("invalid manifest version: '{version}'"));
        }
        let min_native_version = o
            .get("minNativeVersion")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let requires = match o.get("requires") {
            None => Vec::new(),
            Some(v) => v
                .as_array()
                .ok_or("invalid manifest: requires is not an array")?
                .iter()
                .map(|h| match h.as_str() {
                    Some(h) if valid_api_hash(h) => Ok(h.to_string()),
                    _ => Err(format!("invalid native API hash in manifest: {h}")),
                })
                .collect::<Result<_, _>>()?,
        };
        let files = o
            .get("files")
            .and_then(|v| v.as_object())
            .ok_or("invalid manifest: missing files")?;
        let mut entries = BTreeMap::new();
        for (path, f) in files {
            check_path(path)?;
            let f = f
                .as_object()
                .ok_or(format!("invalid manifest entry for {path}"))?;
            let sha256 = f.get("sha256").and_then(|v| v.as_str()).unwrap_or("");
            if !valid_sha256(sha256) {
                return Err(format!("invalid sha256 for {path}"));
            }
            let size = f
                .get("size")
                .and_then(|v| v.as_u64())
                .ok_or(format!("invalid size for {path}"))?;
            entries.insert(
                path.clone(),
                Entry {
                    path: path.clone(),
                    sha256: sha256.into(),
                    size,
                },
            );
        }
        if !entries.contains_key("index.html") {
            return Err("invalid manifest: no index.html".into());
        }
        Ok(Manifest {
            version: version.into(),
            min_native_version,
            requires,
            files: entries,
            raw: raw.into(),
        })
    }

    pub fn same_files(&self, other: &Manifest) -> bool {
        self.files == other.files
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths() {
        for ok in ["index.html", "a/b.js", "dir with space/ü.txt", "a..b/c"] {
            assert!(check_path(ok).is_ok(), "{ok}");
        }
        for bad in [
            "",
            "/abs",
            "../x",
            "a/../../x",
            "a//b",
            "./a",
            "a/.",
            "a\\..\\x",
            "C:/x",
            "content-update.json",
        ] {
            assert!(check_path(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn versions() {
        assert!(valid_version("v1"));
        assert!(valid_version("3f2a9c0d1e2b4a5c"));
        assert!(valid_version("1.2.3-rc_1"));
        assert!(!valid_version(""));
        assert!(!valid_version("../v1"));
        assert!(!valid_version(".v1"));
        assert!(!valid_version(&"a".repeat(65)));
    }

    #[test]
    fn parse() {
        let sha = "a".repeat(64);
        let raw =
            format!(r#"{{"version":"v1","files":{{"index.html":{{"sha256":"{sha}","size":3}}}}}}"#);
        let m = Manifest::parse(&raw).unwrap();
        assert_eq!(m.version, "v1");
        assert_eq!(m.min_native_version, 0);
        assert!(m.requires.is_empty());
        assert_eq!(m.files["index.html"].size, 3);
        assert!(Manifest::parse("{")
            .unwrap_err()
            .contains("invalid manifest"));
        assert!(Manifest::parse(r#"{"version":"v1"}"#)
            .unwrap_err()
            .contains("missing files"));
        assert!(Manifest::parse(r#"{"version":"v1","files":{}}"#)
            .unwrap_err()
            .contains("no index.html"));

        let with = |requires: &str| {
            Manifest::parse(&raw.replacen('{', &format!(r#"{{"requires":{requires},"#), 1))
        };
        assert_eq!(
            with(r#"["0123456789ab"]"#).unwrap().requires,
            ["0123456789ab"]
        );
        for bad in [
            r#""0123456789ab""#,
            r#"["0123456789AB"]"#,
            r#"["abc"]"#,
            "[1]",
        ] {
            assert!(with(bad).is_err(), "{bad}");
        }
    }
}
