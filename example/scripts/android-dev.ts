// `pnpm android:dev [tauri android dev args]`: boots a fresh headless emulator (new AVD, wiped data,
// see scripts/emulator.ts), shows its screen with scrcpy (no emulator toolbar; window class
// `tauri-android-dev` for window manager rules), runs `tauri android dev` on it and deletes the
// emulator again on exit (Ctrl+C, tauri exiting or the scrcpy window being closed).
// Never uses other attached devices.
import { spawn, type ChildProcess } from "node:child_process";
import { startFreshEmulator, stopEmulator } from "./emulator.ts";
import {
  createSession,
  INTERACTIVE_EMULATOR,
  kill,
  requireOnPath,
  startScrcpy,
} from "./session.ts";

const AVD = process.env.ANDROID_DEV_AVD ?? "tauri-dev";
// distinct from the prod (5575) and e2e (5580) emulators so they can run at the same time
const PORT = 5570;

let tauri: ChildProcess | undefined;
let scrcpy: ChildProcess | undefined;
const session = createSession(async () => {
  await kill(tauri, "SIGINT");
  await kill(scrcpy, "SIGTERM");
  await stopEmulator(AVD, PORT);
});

requireOnPath("scrcpy");

try {
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

  scrcpy = startScrcpy(session, {
    serial: emulator.serial,
    avd: AVD,
    windowClass: "tauri-android-dev",
  });

  // the device argument is matched against device names, which are the AVD names for emulators
  tauri = spawn(
    "pnpm",
    ["tauri", "android", "dev", AVD, ...process.argv.slice(2)],
    {
      stdio: "inherit",
      env: { ...process.env, ANDROID_SERIAL: emulator.serial },
    },
  );
  tauri.once(
    "exit",
    (code, signal) => void session.stop(code ?? (signal ? 130 : 1)),
  );
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  await session.stop(1);
}
