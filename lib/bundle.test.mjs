// unit tests of the bundler: `node --test` in this package
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  createBundle,
  createManifest,
  findNativeApi,
  META,
  nativeApiHash,
} from "./bundle.mjs";

function webDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "content-update-test-"));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

const APP = "0123456789ab";

test("native API hashes match the rust side", () => {
  // pinned in tauri-plugin-content-update-build's tests too
  assert.equal(
    nativeApiHash("plugin:content-update|notify_ready"),
    "240505d45b3b",
  );
});

test("finds the plugin and app commands a build uses", () => {
  const dir = webDir({
    "index.html": `<script>invoke("plugin:content-update|notify_ready")</script>`,
    // minified: template literals, no spaces
    "_build/a.js": `q=(e,t)=>pt(\`plugin:event|listen\`,t);x("native-api:app_info:${APP}",{})`,
    "_build/b.mjs": `"plugin:core-x|do_it" 'native-api:other:${APP}f'`,
    // not code
    "notes.txt": `plugin:nope|never native-api:nope:${APP}`,
    // not a plugin command (prefixed)
    "_build/c.js": `"myplugin:x|y" "a-plugin:x|y"`,
  });
  assert.deepEqual(
    Object.fromEntries(findNativeApi(dir)),
    Object.fromEntries([
      [nativeApiHash("plugin:core-x|do_it"), "plugin:core-x|do_it"],
      [nativeApiHash("plugin:event|listen"), "plugin:event|listen"],
      [APP, "app_info"],
      [
        nativeApiHash("plugin:content-update|notify_ready"),
        "plugin:content-update|notify_ready",
      ],
    ]),
  );
});

test("the manifest lists the hashes of the native API a bundle uses", () => {
  const dir = webDir({
    "index.html": `<script>invoke("plugin:content-update|notify_ready"); invoke("plugin:content-update|notify_ready")</script>`,
    "a.js": `call("native-api:app_info:${APP}")`,
  });
  const m = createManifest(dir, {
    version: "v1",
    nativeApi: ["plugin:dynamic|cmd"],
  });
  assert.deepEqual(
    m.requires,
    [
      APP,
      nativeApiHash("plugin:content-update|notify_ready"),
      nativeApiHash("plugin:dynamic|cmd"),
    ].sort(),
  );
  // none: no field
  const plain = createManifest(webDir({ "index.html": "hi" }));
  assert.equal("requires" in plain, false);
  assert.equal("minNativeVersion" in plain, false);
  assert.match(plain.version, /^[0-9a-f]{16}$/);
});

test("createBundle stamps the build and publishes it", () => {
  const dir = webDir({ "index.html": "<p>hi</p>", "a/b.js": "1" });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "content-update-out-"));
  const m = createBundle(dir, { outDir: out, minNativeVersion: "7" });
  assert.equal(m.minNativeVersion, 7);
  assert.deepEqual(Object.keys(m.files), ["a/b.js", "index.html"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, META))), m);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(out, "manifest.json"))),
    m,
  );
  for (const { sha256 } of Object.values(m.files))
    assert.ok(fs.existsSync(path.join(out, "files", sha256)));
  // the stamp isn't part of the bundle: stamping again gives the same manifest
  assert.deepEqual(createManifest(dir, { minNativeVersion: 7 }), m);
  assert.throws(() => createManifest(webDir({ "a.js": "" })), /no index\.html/);
  assert.throws(
    () => createManifest(dir, { version: "../x" }),
    /invalid version/,
  );
});
