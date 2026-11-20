#!/usr/bin/env node
import { parseArgs } from "node:util";
import { writeBindings } from "../lib/bindings.mjs";
import { createBundle, findNativeApi } from "../lib/bundle.mjs";

const usage = `usage: content-update bundle <web-dir> [--out <dir>] [--version <v>] [--min-native-version <code>]
                          [--native-api <id>]...

Writes <web-dir>/content-update.json (run before \`tauri build\`, the app embeds it to know its built-in bundle) and,
with --out, publishes the bundle to <dir>/manifest.json + <dir>/files/<sha256> (serve <dir> statically).
The manifest lists the native API the bundle's code uses (plugin commands, app commands called through the
generated bindings), --native-api adds ids it can't see (\`plugin:<plugin>|<command>\` invoked with computed names).
Env fallbacks: CONTENT_UPDATE_VERSION, CONTENT_UPDATE_MIN_NATIVE_VERSION.

usage: content-update bindings <crate-dir> <out>

Generates the typed bindings of the app's commands (from <crate-dir>/src/**/*.rs) to <out>, the same file the
app's build.rs generates with tauri-plugin-content-update-build. Run it before building the frontend, so a single
\`tauri build\` uses up-to-date bindings.`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string" },
    version: { type: "string" },
    "min-native-version": { type: "string" },
    "native-api": { type: "string", multiple: true },
    help: { type: "boolean", short: "h" },
  },
});

const [command, dir, out] = positionals;
const valid =
  (command == "bundle" && dir) || (command == "bindings" && dir && out);
if (values.help || !valid) {
  console.error(usage);
  process.exit(values.help ? 0 : 1);
}

if (command == "bindings") {
  const changed = writeBindings(dir, out);
  console.log(`content-update: bindings ${out}${changed ? " (updated)" : ""}`);
  process.exit(0);
}

const manifest = createBundle(dir, {
  outDir: values.out,
  version: values.version || process.env.CONTENT_UPDATE_VERSION || undefined,
  minNativeVersion:
    values["min-native-version"] ||
    process.env.CONTENT_UPDATE_MIN_NATIVE_VERSION ||
    undefined,
  nativeApi: values["native-api"],
});
console.log(
  `content-update: bundle ${manifest.version} (${Object.keys(manifest.files).length} files)` +
    (values.out ? ` -> ${values.out}` : ""),
);
const used = [...findNativeApi(dir).values(), ...(values["native-api"] ?? [])];
console.log(
  `content-update: uses ${manifest.requires?.length ?? 0} native APIs: ${[...new Set(used)].sort().join(", ") || "none"}`,
);
