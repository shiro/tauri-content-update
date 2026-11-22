// Shared by the interactive emulator commands (android-dev.ts, android-prod.ts): one `stop()` that
// tears everything down once (Ctrl+C/SIGTERM/SIGHUP, or any part exiting), and the scrcpy window.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { ANDROID_API_LEVEL, type EmulatorOptions } from "./emulator.ts";

/**
 * Emulator settings of the interactive commands (android:dev, android:prod): host GPU rendering
 * (`auto` picks slow software rendering on Mesa drivers, although `host` works there; machines whose
 * GPU can't be used fall back to `auto`), host audio, up to 8 cores, 4 GB RAM.
 * Boot it while the host is idle (not during a build): a renderer that starts too slowly counts as
 * failed and falls back to software rendering.
 */
export const INTERACTIVE_EMULATOR: Omit<EmulatorOptions, "avd" | "port"> = {
  gpu: process.env.ANDROID_DEV_GPU ?? "host",
  gpuFallback: "auto",
  audio: true,
  cores: Math.min(8, os.cpus().length),
  memoryMb: 4096,
};

export const running = (p?: ChildProcess): p is ChildProcess =>
  !!p && p.exitCode == null && p.signalCode == null;

/** Kills `p` with `signal` and waits until it exited. */
export async function kill(
  p: ChildProcess | undefined,
  signal: NodeJS.Signals,
) {
  if (!running(p)) return;
  const exited = new Promise((r) => p.once("exit", r));
  p.kill(signal);
  await exited;
}

export interface Session {
  /** Runs the cleanup once and exits with `code` (the first call's); never resolves. */
  stop(code: number): Promise<never>;
  /** Set once `stop()` was called. */
  readonly stopping: Promise<never> | undefined;
}

export function createSession(cleanup: () => Promise<void>): Session {
  let stopping: Promise<never> | undefined;
  const stop = (code: number) =>
    (stopping ??= (async () => {
      try {
        await cleanup();
      } catch (e) {
        console.error(e instanceof Error ? e.message : e);
      }
      process.exit(code);
    })());
  // Ctrl+C also reaches the children (same process group); the emulator runs detached and is
  // stopped by the cleanup in any case
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.on(signal, () => void stop(130));
  return {
    stop,
    get stopping() {
      return stopping;
    },
  };
}

/** Exits if a binary is missing, before booting the emulator (e.g. a nix-shell predating it). */
export function requireOnPath(bin: string) {
  const found = (process.env.PATH ?? "")
    .split(path.delimiter)
    .some((dir) => dir && fs.existsSync(path.join(dir, bin)));
  if (found) return;
  console.error(
    `${bin} not found on PATH: run this inside a current \`nix-shell shell.nix\` (re-enter it if it predates ${bin} being added)`,
  );
  process.exit(1);
}

/**
 * Shows the emulator screen with scrcpy (no emulator toolbar). `windowClass` = Wayland app_id /
 * X11 WM_CLASS of the window, for window manager rules. Closing the window stops the session.
 */
export function startScrcpy(
  session: Session,
  opts: { serial: string; avd: string; windowClass: string },
): ChildProcess {
  const scrcpyLog = path.join(os.tmpdir(), `scrcpy-${opts.avd}.log`);
  const log = fs.openSync(scrcpyLog, "w");
  const scrcpy = spawn(
    "scrcpy",
    [
      "--serial",
      opts.serial,
      `--window-title=${opts.avd} (API ${ANDROID_API_LEVEL})`,
      // the emulator plays its audio on the host itself
      "--no-audio",
    ],
    {
      stdio: ["ignore", log, log],
      env: { ...process.env, SDL_APP_ID: opts.windowClass },
    },
  );
  fs.closeSync(log);
  scrcpy.once("error", (e) => {
    console.error(`scrcpy failed to start: ${e.message}`);
    void session.stop(1);
  });
  scrcpy.once("exit", (code) => {
    if (session.stopping) return;
    if (code) console.error(`scrcpy exited (${code}), see ${scrcpyLog}`);
    else console.log("emulator window closed");
    void session.stop(code ? 1 : 0);
  });
  return scrcpy;
}

/** Prints the stdout/stderr lines of `p` with a `[prefix]`. */
export function prefixOutput(p: ChildProcess, prefix: string) {
  for (const stream of [p.stdout, p.stderr])
    if (stream)
      readline
        .createInterface({ input: stream })
        .on("line", (line) => console.log(`[${prefix}] ${line}`));
}
