// The JS port must produce exactly what the Rust generator (build/) produces: both are checked
// against the same expected files in build/fixtures (`UPDATE_FIXTURES=1 cargo test` in
// build/ rewrites them from the Rust output).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { analyze, render, scan, writeBindings } from "./bindings.mjs";

const pkg = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = path.join(pkg, "build", "fixtures");
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : null);

const cases = fs
  .readdirSync(fixtures)
  .filter((c) => fs.statSync(path.join(fixtures, c)).isDirectory())
  .sort();

test("there are fixtures", () => assert.ok(cases.length > 0));

for (const name of cases) {
  test(`fixture ${name}`, () => {
    const dir = path.join(fixtures, name);
    const error = read(path.join(dir, "error.txt"));
    if (error !== null) {
      assert.throws(
        () => scan(path.join(dir, "src")),
        (e) => {
          assert.equal(`${e.message}\n`, error);
          return true;
        },
      );
      return;
    }
    const api = scan(path.join(dir, "src"));
    assert.equal(
      api.commands.map((c) => `${c.signature}\n`).join(""),
      read(path.join(dir, "signatures.txt")),
    );
    assert.equal(render(api), read(path.join(dir, "bindings.ts")));
  });
}

test("signature format is pinned", () => {
  // same as `signature_format_is_pinned` in build/src/tests.rs
  const api = analyze([
    `
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Info { app_version: String, tags: Vec<String>, size: Option<u64> }

    #[tauri::command]
    fn info(app: AppHandle, name: String) -> Result<Info, String> { todo!() }

    fn run() { builder.invoke_handler(tauri::generate_handler![info]); }
`,
  ]);
  assert.equal(
    api.commands[0].signature,
    'info(name:string)->result<struct{#[serde (rename_all = "camelCase")];app_version:string,tags:[string],size:option<number>},string>',
  );
});

test("writeBindings only writes on changes", () => {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "bindings-"));
  try {
    fs.cpSync(path.join(fixtures, "bindings", "src"), path.join(tmp, "src"), {
      recursive: true,
    });
    const out = path.join(tmp, "gen", "native.gen.ts");
    assert.equal(writeBindings(tmp, out), true);
    assert.equal(
      read(out),
      read(path.join(fixtures, "bindings", "bindings.ts")),
    );
    assert.equal(writeBindings(tmp, out), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
