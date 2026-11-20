use serde::{Deserialize, Serialize};

/// Field renames.
///
/// Second paragraph with a */ in it.
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE", deny_unknown_fields)]
pub struct Renamed {
    pub first_field: u8,
    #[serde(rename = "explicit-name")]
    pub second_field: u8,
    #[serde(rename(serialize = "ser_name", deserialize = "de_name"))]
    pub third_field: u8,
    #[serde(rename(deserialize = "only_de"))]
    pub fourth_field: u8,
    #[serde(default)]
    pub with_default: Vec<u8>,
    #[serde(default = "default_value", with = "some_module")]
    pub with_default_fn: u32,
    #[serde(skip_serializing_if = "Vec::is_empty", rename = "listed")]
    pub list: Vec<String>,
    #[serde(skip_serializing)]
    pub not_sent: bool,
    #[serde(flatten)]
    pub extra: Extra,
    #[serde(flatten)]
    pub more: std::collections::HashMap<String, serde_json::Value>,
    #[serde(bound(serialize = "T: Serialize"), alias = "x")]
    pub bounded: bool,
    #[serde(rename = "with \"quotes\" and \\")]
    pub quoted: bool,
    #[serde(rename = r#"raw "name""#)]
    pub raw_named: bool,
    /// multi
    /// line
    ///
    /// doc
    pub documented: bool,
    #[doc = "explicit doc"]
    #[doc = " with \"escapes\""]
    pub explicit_doc: bool,
    /** block doc */
    pub block_doc: bool,
    #[serde(untagged = "bad", rename = "after_error")]
    pub after_error: bool,
    #[serde(rename = "first")]
    #[serde(rename = "second")]
    pub renamed_twice: bool,
    #[serde(rename = 5)]
    pub bad_rename: bool,
}

#[derive(Serialize)]
pub struct Extra {
    pub a: u8,
}

#[serde(rename_all = "PascalCase")]
pub struct Pascal { pub some_field: u8, pub r#type: u8 }
#[serde(rename_all = "kebab-case")]
pub struct Kebab { pub some_field: u8 }
#[serde(rename_all = "SCREAMING-KEBAB-CASE")]
pub struct ScreamingKebab { pub some_field: u8 }
#[serde(rename_all = "lowercase")]
pub struct Lower { pub some_field: u8 }
#[serde(rename_all = "UPPERCASE")]
pub struct Upper { pub some_field: u8 }
#[serde(rename_all = "snake_case")]
pub struct Snake { pub some_field: u8 }
#[serde(rename_all = "unknownCase")]
pub struct Unknown { pub some_field: u8 }
#[serde(rename_all(serialize = "camelCase"))]
pub struct SerOnly { pub some_field: u8 }

#[derive(Serialize)]
#[serde(transparent)]
pub struct Transparent { #[serde(skip)] skipped: u8, pub inner: Vec<String> }
#[serde(transparent)]
pub struct TransparentEmpty { #[serde(skip)] skipped: u8 }
pub struct Newtype(pub Vec<u8>);
pub struct Pair(pub u8, pub(crate) String);
pub struct Unit;
pub struct Empty {}

/// Externally tagged.
pub enum External {
    /// a unit
    Unit,
    Newtype(u8),
    Tuple(u8, String),
    Struct { some_field: u8, #[serde(rename = "x-y")] other: bool },
    #[serde(rename = "renamed")]
    Renamed,
    #[serde(skip)]
    Skipped(u8),
    #[serde(rename_all = "camelCase")]
    StructRenamed { some_field: u8 },
    WithDiscriminant = 5,
}

#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Internal {
    UnitVariant,
    Newtype(Extra),
    Struct { a: u8 },
}

#[serde(tag = "t", content = "c")]
pub enum Adjacent {
    Unit,
    Newtype(u8),
    Tuple(u8, u8),
    Struct { a: u8 },
}

#[serde(untagged)]
pub enum Untagged {
    Unit,
    Number(u8),
    Tuple(u8, u8),
    Struct { a: u8 },
}

#[serde(tag = "my-tag")]
pub enum QuotedTag { Variant }

#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Screaming { HttpServer, A, ABC, UnicodeÉté }

pub enum Never {}

pub enum OnlySkipped { #[serde(skip)] A }

#[tauri::command]
pub fn serde_types(
    renamed: Renamed,
    pascal: Pascal,
    kebab: Kebab,
    screaming_kebab: ScreamingKebab,
    lower: Lower,
    upper: Upper,
    snake: Snake,
    unknown: Unknown,
    ser_only: SerOnly,
    transparent: Transparent,
    transparent_empty: TransparentEmpty,
    newtype: Newtype,
    pair: Pair,
    unit: Unit,
    empty: Empty,
) {
}

#[tauri::command]
pub fn serde_enums(
    external: External,
    internal: Internal,
    adjacent: Adjacent,
    untagged: Untagged,
    quoted_tag: QuotedTag,
    screaming: Screaming,
    never: Never,
    only_skipped: OnlySkipped,
) {
}

pub fn run() {
    tauri::Builder::default().invoke_handler(tauri::generate_handler![serde_types, serde_enums,]);
}
