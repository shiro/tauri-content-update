#!/usr/bin/env node
// Smoke test of the published npm package: packs the real tarball, installs it into an empty project
// and uses it from there (runtime imports, types, CLI). The example links the repository (`link:..`), so
// this is what catches files missing from `files` in package.json. Run by CI (`pnpm test:pack`).
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

// the runtime exports of each entry point (each must also be declared in its types)
const entries = {
  [pkg.name]: ["ContentUpdate", "ContentUpdateError", "sync"],
  [`${pkg.name}/bundle`]: [
    "META",
    "HASH_LEN",
    "nativeApiHash",
    "findNativeApi",
    "createManifest",
    "createBundle",
  ],
  [`${pkg.name}/bindings`]: [
    "MARKER",
    "analyze",
    "scan",
    "render",
    "writeBindings",
    "rename",
  ],
};

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: "pipe" });
const step = (name) => console.log(`pack-smoke: ${name}`);

const tmp = mkdtempSync(join(tmpdir(), "content-update-pack-"));
try {
  step("pack");
  const [{ filename }] = JSON.parse(
    run("npm", ["pack", "--json", "--pack-destination", tmp], root),
  );
  const tarball = join(tmp, filename);

  step("install the tarball into an empty project");
  const app = join(tmp, "app");
  mkdirSync(app);
  writeFileSync(
    join(app, "package.json"),
    JSON.stringify({
      name: "pack-smoke",
      private: true,
      type: "module",
      dependencies: {
        [pkg.name]: `file:${tarball}`,
        "@tauri-apps/api": pkg.devDependencies["@tauri-apps/api"],
      },
    }),
  );
  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
    ],
    app,
  );

  step("import the entry points");
  const check = Object.entries(entries)
    .map(
      ([spec, names], i) =>
        `const m${i} = await import(${JSON.stringify(spec)});\n` +
        `for (const n of ${JSON.stringify(names)}) if (m${i}[n] === undefined) throw new Error(${JSON.stringify(spec)} + " has no export " + n);`,
    )
    .join("\n");
  writeFileSync(join(app, "imports.mjs"), check);
  run(process.execPath, ["imports.mjs"], app);

  step("cli: bindings");
  const fixture = join(root, "build/fixtures/app");
  const bin = join(app, "node_modules/.bin/content-update");
  run(bin, ["bindings", fixture, "bindings.ts"], app);
  if (
    readFileSync(join(app, "bindings.ts"), "utf8") !=
    readFileSync(join(fixture, "bindings.ts"), "utf8")
  )
    throw new Error(
      "`content-update bindings` output differs from the fixture",
    );

  step("cli: bundle");
  const web = join(app, "web");
  mkdirSync(web);
  writeFileSync(join(web, "index.html"), "<!doctype html><title>smoke</title>");
  writeFileSync(join(web, "app.js"), readFileSync(join(app, "bindings.ts")));
  run(bin, ["bundle", "web", "--out", "out", "--version", "smoke"], app);
  const manifest = JSON.parse(
    readFileSync(join(app, "out/manifest.json"), "utf8"),
  );
  if (manifest.version != "smoke" || !manifest.files["index.html"])
    throw new Error("unexpected manifest: " + JSON.stringify(manifest));
  if (!manifest.requires?.length)
    throw new Error("the bundle found no native API in the bindings");
  if (!existsSync(join(web, "content-update.json")))
    throw new Error("`content-update bundle` wrote no content-update.json");

  step("typecheck (the types of each entry point and the generated bindings)");
  writeFileSync(
    join(app, "types.mts"),
    Object.entries(entries)
      .map(
        ([spec, names], i) =>
          `import * as m${i} from ${JSON.stringify(spec)};\n` +
          names.map((n) => `void m${i}.${n};`).join("\n"),
      )
      .join("\n") +
      `\nimport type { UpdateInfo, ContentUpdateState, SyncResult } from ${JSON.stringify(pkg.name)};\n` +
      `import type { Manifest } from ${JSON.stringify(`${pkg.name}/bundle`)};\n` +
      `import type { Api } from ${JSON.stringify(`${pkg.name}/bindings`)};\n` +
      `export type T = [UpdateInfo, ContentUpdateState, SyncResult, Manifest, Api];\n` +
      `export * from "./bindings.js";\n`,
  );
  writeFileSync(
    join(app, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "nodenext",
        moduleResolution: "nodenext",
        // what a web app compiles with (@tauri-apps/api's types use esnext symbols)
        target: "esnext",
        lib: ["esnext", "dom"],
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        types: [],
      },
      files: ["types.mts", "bindings.ts"],
    }),
  );
  const tsc = createRequire(join(root, "package.json")).resolve(
    "typescript/bin/tsc",
  );
  run(process.execPath, [tsc, "-p", "tsconfig.json"], app);

  console.log(`pack-smoke: ok (${filename})`);
} catch (e) {
  if (e.stdout || e.stderr) console.error(`${e.stdout ?? ""}${e.stderr ?? ""}`);
  console.error(e.message);
  process.exitCode = 1;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
