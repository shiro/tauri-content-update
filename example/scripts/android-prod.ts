// `pnpm android:prod [--backend-url <url>] [--headless]`: runs the production app (the web build
// embedded in the APK, no dev server) on a fresh emulator together with its backend, and stops
// everything together.
//
// 1. boots a fresh headless emulator with the same settings as android:dev (AVD `tauri-prod`, host
//    GPU, see INTERACTIVE_EMULATOR in scripts/session.ts), then builds the APK
//    (`tauri android build --debug`, same as `pnpm android:apk`, so it replaces that APK) with
//    VITE_BACKEND_URL (src/backend.ts)
// 2. starts the backend of that build (`node .output/server/index.mjs` on 127.0.0.1:3001, output
//    prefixed `[backend]`), reachable from the device as http://localhost:3001 through `adb reverse`
// 3. installs and launches the app, shows the emulator with scrcpy (window class
//    `tauri-android-prod`) and prints the app's logcat (`[app]`)
// 4. on Ctrl+C, the scrcpy window being closed, the emulator or the backend exiting: stops the
//    backend, logcat and scrcpy and deletes the emulator
//
// `--backend-url <url>`: build against another backend (e.g. a deployed one) instead of starting the
// local one. `--headless`: no scrcpy window (stop with Ctrl+C).
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { parseArgs } from "node:util";
import { ADB, adb, startFreshEmulator, stopEmulator } from "./emulator.ts";
import {
  createSession,
  INTERACTIVE_EMULATOR,
  kill,
  prefixOutput,
  requireOnPath,
  running,
  startScrcpy,
} from "./session.ts";

const AVD = process.env.ANDROID_PROD_AVD ?? "tauri-prod";
// distinct from the dev (5570) and e2e (5580) emulators so they can run at the same time
const PORT = 5575;
const BACKEND_PORT = 3001;
const WEB_DIR = path.resolve(import.meta.dirname, "..");
const APP_ID: string = JSON.parse(
  fs.readFileSync(path.join(WEB_DIR, "src-tauri/tauri.conf.json"), "utf-8"),
).identifier;
const APK = path.join(
  WEB_DIR,
  "src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk",
);

const { values: args } = parseArgs({
  options: {
    "backend-url": { type: "string" },
    headless: { type: "boolean", default: false },
  },
});
const localBackend = !args["backend-url"];
const backendUrl = args["backend-url"] ?? `http://localhost:${BACKEND_PORT}`;

let build: ChildProcess | undefined;
let backend: ChildProcess | undefined;
let logcat: ChildProcess | undefined;
let scrcpy: ChildProcess | undefined;
const session = createSession(async () => {
  await kill(build, "SIGINT");
  await kill(logcat, "SIGTERM");
  await kill(scrcpy, "SIGTERM");
  await kill(backend, "SIGTERM");
  await stopEmulator(AVD, PORT);
});

const portFree = (port: number) =>
  new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });

function buildApk() {
  console.log(`building the APK (backend ${backendUrl})`);
  build = spawn(
    "pnpm",
    ["tauri", "android", "build", "--debug", "--apk", "--target", "x86_64"],
    {
      cwd: WEB_DIR,
      stdio: "inherit",
      env: { ...process.env, VITE_BACKEND_URL: backendUrl },
    },
  );
  return new Promise<void>((resolve, reject) =>
    build!.once("exit", (code, signal) =>
      code == 0
        ? resolve()
        : reject(new Error(`APK build failed (${code ?? signal})`)),
    ),
  );
}

async function startBackend() {
  console.log(`starting the backend on 127.0.0.1:${BACKEND_PORT}`);
  backend = spawn("node", [".output/server/index.mjs"], {
    cwd: WEB_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: `${BACKEND_PORT}`,
      HOST: "127.0.0.1",
    },
  });
  prefixOutput(backend, "backend");
  backend.once("exit", (code, signal) => {
    if (session.stopping) return;
    console.error(`backend exited (${code ?? signal})`);
    void session.stop(1);
  });
  const end = Date.now() + 30_000;
  while (running(backend)) {
    const up = await fetch(`http://127.0.0.1:${BACKEND_PORT}/`).then(
      () => true,
      () => false,
    );
    if (up) return;
    if (Date.now() > end) throw new Error("the backend did not start");
    await new Promise((r) => setTimeout(r, 200));
  }
}

if (!args.headless) requireOnPath("scrcpy");
if (localBackend && !(await portFree(BACKEND_PORT))) {
  console.error(`port ${BACKEND_PORT} (backend) is already in use`);
  process.exit(1);
}

try {
  // booted like android:dev's, before the build: booting during the build can make the host GPU
  // renderer count as failed and fall back to (slow) software rendering
  const emulator = await startFreshEmulator({
    ...INTERACTIVE_EMULATOR,
    avd: AVD,
    port: PORT,
  });
  if (session.stopping) await session.stopping;
  emulator.process.once("exit", () => {
    if (session.stopping) return;
    console.log("emulator exited");
    void session.stop(1);
  });
  const { serial } = emulator;

  await buildApk();
  if (session.stopping) await session.stopping;

  if (localBackend) {
    await startBackend();
    // the app reaches the backend as localhost on the device
    await adb(serial, [
      "reverse",
      `tcp:${BACKEND_PORT}`,
      `tcp:${BACKEND_PORT}`,
    ]);
  }

  console.log(`installing ${path.relative(WEB_DIR, APK)}`);
  await adb(serial, ["install", "-r", "-t", APK]);
  await adb(serial, ["logcat", "-c"]);
  await adb(serial, [
    "shell",
    "monkey",
    "-p",
    APP_ID,
    "-c",
    "android.intent.category.LAUNCHER",
    "1",
  ]);

  if (!args.headless)
    scrcpy = startScrcpy(session, {
      serial,
      avd: AVD,
      windowClass: "tauri-android-prod",
    });

  let pid = "";
  for (let i = 0; i < 50 && !pid; i++) {
    pid = await adb(serial, ["shell", "pidof", APP_ID]).catch(() => "");
    if (!pid) await new Promise((r) => setTimeout(r, 200));
  }
  if (pid) {
    logcat = spawn(ADB, ["-s", serial, "logcat", "-v", "tag", `--pid=${pid}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    prefixOutput(logcat, "app");
  } else console.error(`${APP_ID} is not running, no app log`);

  console.log(
    `running the production app${localBackend ? " and its backend" : ""}, Ctrl+C to stop`,
  );
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  await session.stop(1);
}
