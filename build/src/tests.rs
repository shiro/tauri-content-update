use super::*;

fn api(src: &str) -> Api {
    try_api(src).unwrap()
}

fn try_api(src: &str) -> Result<Api, String> {
    analyze(&[syn::parse_file(src).unwrap()])
}

/// signature of the only command
fn sig(src: &str) -> String {
    let api = api(src);
    assert_eq!(api.commands.len(), 1);
    api.commands[0].signature.clone()
}

const BASE: &str = r#"
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Info { app_version: String, tags: Vec<String>, size: Option<u64> }

    #[tauri::command]
    fn info(app: AppHandle, name: String) -> Result<Info, String> { todo!() }

    fn run() { builder.invoke_handler(tauri::generate_handler![info]); }
"#;

#[test]
fn hash_format() {
    // shared with the JS bundler (lib/bundle.mjs): truncated sha256, lowercase hex
    assert_eq!(hash("plugin:content-update|notify_ready"), "240505d45b3b");
    assert_eq!(hash("plugin:content-update|notify_ready").len(), HASH_LEN);
}

#[test]
fn signature_format_is_pinned() {
    // the canonical form is part of the hash format: a change here changes every hash, which makes
    // all published bundles incompatible with apps built before
    assert_eq!(
        sig(BASE),
        "info(name:string)->result<struct{#[serde (rename_all = \"camelCase\")];app_version:string,tags:[string],size:option<number>},string>"
    );
}

#[test]
fn irrelevant_changes_keep_the_hash() {
    let base = sig(BASE);
    for (what, src) in [
        (
            "docs, derives and formatting",
            r#"
            /// docs
            #[derive(Serialize, Debug, Clone)]
            #[serde(rename_all = "camelCase")]
            struct Info {
                /// the version
                app_version: String,
                tags: Vec<String>,
                size: Option<u64>,
            }
            /// a command
            #[tauri::command(async)]
            async fn info(window: tauri::Window, name: &str, state: State<'_, X>) -> Result<Info, String> { other() }
            fn run() { tauri::generate_handler![commands::info] }
            "#,
        ),
        (
            "renamed rust types and equivalent ones",
            r#"
            #[serde(rename_all = "camelCase")]
            struct AppInfo { app_version: Box<str>, tags: Vec<Cow<'static, str>>, size: Option<u32> }
            type Res<T> = std::result::Result<T, String>;
            #[command]
            fn info(name: String) -> Res<AppInfo> { todo!() }
            fn run() { generate_handler![info] }
            "#,
        ),
    ] {
        assert_eq!(sig(src), base, "{what}");
    }
}

#[test]
fn wire_changes_change_the_hash() {
    let base = sig(BASE);
    for (what, from, to) in [
        ("argument type", "name: String", "name: u32"),
        ("argument name", "name: String", "label: String"),
        (
            "added argument",
            "name: String",
            "name: String, force: bool",
        ),
        (
            "result type",
            "Result<Info, String>",
            "Result<String, String>",
        ),
        ("error type", "Result<Info, String>", "Result<Info, u32>"),
        ("field type", "size: Option<u64>", "size: u64"),
        ("field name", "tags: Vec<String>", "labels: Vec<String>"),
        (
            "added field",
            "size: Option<u64> }",
            "size: Option<u64>, extra: bool }",
        ),
        ("serde attribute", "camelCase", "snake_case"),
        ("command name", "fn info(", "fn info2("),
    ] {
        let src = BASE.replace(from, to).replace("[info]", "[info, info2]");
        // commands registered but not defined are an error, so register the renamed one only when
        // it exists
        let src = if src.contains("fn info2(") {
            src.replace("[info, info2]", "[info2]")
        } else {
            src.replace("[info, info2]", "[info]")
        };
        assert_ne!(sig(&src), base, "{what}");
    }
}

#[test]
fn only_registered_commands_count() {
    let api = api(r#"
        #[tauri::command] fn a() {}
        #[tauri::command] fn b() -> u8 { 1 }
        fn c() {}
        fn run() { tauri::generate_handler![b, a] }
    "#);
    let names: Vec<_> = api.commands.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, ["a", "b"]);
    assert_eq!(api.commands[0].signature, "a()->null");

    let err =
        try_api("#[tauri::command] fn a() {} fn run() { generate_handler![a, gone] }").unwrap_err();
    assert!(err.contains("`gone`"), "{err}");
    let err = try_api(
        "mod x { #[command] fn a() {} } mod y { #[command] fn a() {} } fn r() { generate_handler![x::a] }",
    )
    .unwrap_err();
    assert!(err.contains("more than once"), "{err}");
}

#[test]
fn argument_keys_follow_the_command_rename_all() {
    let src = r#"
        #[tauri::command] fn a(file_name: String) {}
        #[tauri::command(rename_all = "snake_case")] fn b(file_name: String) {}
        fn run() { generate_handler![a, b] }
    "#;
    let api = api(src);
    assert_eq!(api.commands[0].signature, "a(fileName:string)->null");
    assert_eq!(api.commands[1].signature, "b(file_name:string)->null");
}

#[test]
fn recursive_and_generic_types() {
    let api = api(r#"
        struct Tree { children: Vec<Tree> }
        struct Page<T> { items: Vec<T>, next: Option<u32> }
        #[command] fn a(t: Tree) -> Page<bool> { todo!() }
        fn run() { generate_handler![a] }
    "#);
    assert_eq!(
        api.commands[0].signature,
        "a(t:struct{;children:[#Tree]})->struct{;items:[boolean],next:option<number>}"
    );
}

#[test]
fn bindings() {
    let api = api(r#"
        /// What the app reports.
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        pub struct Info {
            /// the version
            pub app_version: String,
            #[serde(skip_serializing_if = "Option::is_none")]
            pub size: Option<u64>,
            #[serde(skip)]
            pub secret: String,
            pub kind: Kind,
            pub pages: Page<String>,
        }
        #[serde(rename_all = "kebab-case")]
        pub enum Kind { DesktopApp, Mobile }
        #[serde(tag = "type")]
        pub enum Event { Started { at: u64 }, Stopped }
        pub struct Page<T> { items: Vec<T> }

        /// Says hello.
        #[tauri::command]
        fn greet(app: AppHandle, r#type: String, user_name: Option<String>) -> String { todo!() }
        #[tauri::command]
        async fn info() -> Result<Info, Error> { todo!() }
        #[tauri::command]
        fn events(on_event: Channel<Event>) {}
        fn run() { generate_handler![greet, info, events] }
    "#);
    let ts = render(&api);
    let h = |name: &str| {
        hash(
            &api.commands
                .iter()
                .find(|c| c.name == name)
                .unwrap()
                .signature,
        )
    };
    let expected = format!(
        r#"// Generated from the app's tauri commands by tauri-plugin-content-update (build.rs or `content-update bindings`), do not edit.
// The `native-api:<command>:<hash>` ids tell `content-update bundle` which native API a web bundle uses.
import {{ Channel, invoke }} from "@tauri-apps/api/core";

function call<T>(id: string, args?: Record<string, unknown>): Promise<T> {{
  return invoke<T>(id.split(":")[1], args);
}}

export type Event =
  | {{ type: "Started"; at: number }}
  | {{ type: "Stopped" }};

/** What the app reports. */
export type Info = {{
  /** the version */
  appVersion: string;
  size?: number | null;
  kind: Kind;
  pages: Page<string>;
}};

export type Kind =
  | "desktop-app"
  | "mobile";

export type Page<T> = {{
  items: T[];
}};

export function events(onEvent: Channel<Event>): Promise<void> {{
  return call<void>("native-api:events:{}", {{ onEvent }});
}}

/** Says hello. */
export function greet(type: string, userName: string | null): Promise<string> {{
  return call<string>("native-api:greet:{}", {{ type, userName }});
}}

export function info(): Promise<Info> {{
  return call<Info>("native-api:info:{}");
}}
"#,
        h("events"),
        h("greet"),
        h("info"),
    );
    assert_eq!(ts, expected);
    assert_eq!(
        markers(&ts).into_iter().map(|(n, _)| n).collect::<Vec<_>>(),
        ["events", "greet", "info"]
    );
}

#[test]
fn markers_in_minified_code() {
    let h = "0123456789ab";
    let js = format!("x(`native-api:a_b:{h}`),y(\"native-api:c:{h}0\"),z('native-api::{h}')");
    // a longer hex run isn't a marker
    assert_eq!(markers(&js), [("a_b".to_string(), h.to_string())]);
}

#[test]
fn rename_rules() {
    for (rule, field, variant) in [
        ("camelCase", "appVersion", "desktopApp"),
        ("PascalCase", "AppVersion", "DesktopApp"),
        ("snake_case", "app_version", "desktop_app"),
        ("SCREAMING_SNAKE_CASE", "APP_VERSION", "DESKTOP_APP"),
        ("kebab-case", "app-version", "desktop-app"),
        ("SCREAMING-KEBAB-CASE", "APP-VERSION", "DESKTOP-APP"),
        ("lowercase", "app_version", "desktopapp"),
        ("UPPERCASE", "APP_VERSION", "DESKTOPAPP"),
    ] {
        assert_eq!(rust::rename(rule, "app_version", false), field, "{rule}");
        assert_eq!(rust::rename(rule, "DesktopApp", true), variant, "{rule}");
    }
}

/// The cases shared with the JS port (lib/bindings.test.mjs checks them against the same files):
/// `fixtures/<case>/src/**/*.rs` and the expected `bindings.ts` + `signatures.txt`, or `error.txt`.
/// `UPDATE_FIXTURES=1 cargo test` rewrites the expected files.
#[test]
fn fixtures() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures");
    let update = env::var_os("UPDATE_FIXTURES").is_some();
    let mut cases: Vec<_> = fs::read_dir(&root)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.is_dir())
        .collect();
    cases.sort();
    assert!(!cases.is_empty());
    let mut failed = Vec::new();
    for case in cases {
        let expected: Vec<(&str, String)> = match scan(&case.join("src")) {
            Ok(api) => vec![
                ("bindings.ts", render(&api)),
                (
                    "signatures.txt",
                    api.commands
                        .iter()
                        .map(|c| format!("{}\n", c.signature))
                        .collect(),
                ),
            ],
            Err(e) => vec![("error.txt", format!("{e}\n"))],
        };
        for name in ["bindings.ts", "signatures.txt", "error.txt"] {
            let path = case.join(name);
            let want = expected.iter().find(|(n, _)| *n == name).map(|(_, v)| v);
            if update {
                match want {
                    Some(v) => fs::write(&path, v).unwrap(),
                    None => {
                        let _ = fs::remove_file(&path);
                    }
                }
            } else if fs::read_to_string(&path).ok().as_ref() != want {
                failed.push(path.display().to_string());
            }
        }
    }
    assert!(
        failed.is_empty(),
        "differs from the output (UPDATE_FIXTURES=1 rewrites it):\n{}",
        failed.join("\n")
    );
}

#[test]
fn merge_patch() {
    let mut v = serde_json::json!({ "a": { "b": 1, "c": 2 }, "d": 3 });
    merge(
        &mut v,
        serde_json::json!({ "a": { "b": null, "e": 4 }, "d": [1] }),
    );
    assert_eq!(v, serde_json::json!({ "a": { "c": 2, "e": 4 }, "d": [1] }));
}
