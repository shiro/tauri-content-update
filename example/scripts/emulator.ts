// Android emulator lifecycle shared by `pnpm android:dev` (scripts/android-dev.ts) and the e2e tests
// (tests/android.setup.ts / android.teardown.ts). Every start force-cleans whatever a previous run
// left behind (emulator processes, adb entry, AVD files and locks), creates a new AVD and boots it with
// wiped data and without snapshots; stopping deletes it again. Nothing carries over between runs and
// nothing has to be set up beforehand.
// Plain node (type stripping) compatible: explicit `.ts` imports, no TS-only runtime syntax.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fixEnv } from "./env.ts";

fixEnv();

/**
 * Android version (API level) of the emulator (dev and e2e).
 * shell.nix reads this line to install its system image.
 * Broken: 35, 36 (adb drops under load after a cold boot). Works: 32-34, 36.1, 37.0.
 */
export const ANDROID_API_LEVEL = "36.1";

export const ANDROID_HOME =
  process.env.ANDROID_HOME ??
  process.env.ANDROID_SDK_ROOT ??
  path.join(os.homedir(), "Android/Sdk");
/** SDK with the emulator, avdmanager and the system image (shell.nix keeps it separate) */
export const EMULATOR_SDK = process.env.ANDROID_E2E_SDK ?? ANDROID_HOME;
export const SYSTEM_IMAGE = `system-images;android-${ANDROID_API_LEVEL};google_apis;x86_64`;
/** hardware profile of the created AVDs */
export const DEVICE = "pixel_5";
/** where the AVDs are created (shell.nix sets it, the emulator's default otherwise) */
const AVD_HOME =
  process.env.ANDROID_AVD_HOME ?? path.join(os.homedir(), ".android/avd");
/** the SDK's adb (not whatever else is on PATH), so client and server versions match */
export const ADB =
  [path.join(ANDROID_HOME, "platform-tools/adb")].find((p) =>
    fs.existsSync(p),
  ) ?? "adb";

export const sdkTool = (rel: string) => path.join(EMULATOR_SDK, rel);

// nix-composed SDKs have a versioned cmdline-tools dir (no `latest`)
export const avdmanager = () => {
  const dir = path.join(EMULATOR_SDK, "cmdline-tools");
  const ver = [
    "latest",
    ...(fs.existsSync(dir) ? fs.readdirSync(dir) : []),
  ].find((v) => fs.existsSync(path.join(dir, v, "bin/avdmanager")));
  if (!ver) throw new Error(`avdmanager not found in ${dir}`);
  return path.join(dir, ver, "bin/avdmanager");
};

export const sh = (
  cmd: string,
  args: string[],
  input?: string,
  env?: NodeJS.ProcessEnv,
) =>
  new Promise<string>((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      { maxBuffer: 64 << 20, env: env ?? process.env },
      (err, stdout, stderr) =>
        err
          ? reject(
              new Error(
                [
                  `${cmd} ${args.join(" ")} failed: ${err.message.split("\n")[0]}`,
                  stdout.trim(),
                  stderr.trim(),
                ]
                  .filter(Boolean)
                  .join("\n"),
              ),
            )
          : resolve(stdout.trim()),
    );
    if (input !== undefined) child.stdin?.end(input);
  });

export const adb = (serial: string, args: string[]) =>
  sh(ADB, ["-s", serial, ...args]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** serials known to adb (any state) */
const adbSerials = async () =>
  (await sh(ADB, ["devices"]))
    .split("\n")
    .slice(1)
    .map((l) => l.trim().split(/\s+/)[0])
    .filter(Boolean);

/** env for the emulator tools: the emulator SDK, our AVD home */
const toolEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  ANDROID_HOME: EMULATOR_SDK,
  ANDROID_SDK_ROOT: EMULATOR_SDK,
  ANDROID_AVD_HOME: AVD_HOME,
});

export async function waitForBoot(serial: string, timeoutMs = 4 * 60_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const booted = await adb(serial, [
      "shell",
      "getprop",
      "sys.boot_completed",
    ]).catch(() => "");
    if (booted == "1") return;
    await sleep(2000);
  }
  throw new Error(`device ${serial} did not boot in ${timeoutMs / 1000}s`);
}

// a few seconds after the first boot the emulator enables the device profile's resource overlays,
// which relaunches every activity (and so destroys an app's webview); apps are launched after that
// (slower on CI runners: software rendering, fewer cores)
async function waitForDeviceOverlays(
  serial: string,
  timeoutMs = process.env.CI ? 3 * 60_000 : 60_000,
) {
  const end = Date.now() + timeoutMs;
  const enabled = new RegExp(
    `\\[x\\] com\\.android\\.\\S*emulation\\.${DEVICE}\\r?$`,
    "gm",
  );
  // on some runners (CI, emulator 37.3.10) the emulator never enables them itself: after a grace
  // period, enable the disabled ones through the overlay manager
  const forceAt = Date.now() + 60_000;
  let forced = false;
  while (true) {
    const list = await adb(serial, ["shell", "cmd", "overlay", "list"]).catch(
      () => "",
    );
    if (list.match(enabled)?.length == 2) return;
    if (!forced && Date.now() > forceAt) {
      forced = true;
      const disabled = list
        .split("\n")
        .map((l) => l.match(/^\[ \] (\S+)\r?$/)?.[1])
        .filter(
          (name): name is string =>
            !!name && name.includes(`emulation.${DEVICE}`),
        );
      for (const name of disabled) {
        const out = await adb(serial, [
          "shell",
          "cmd",
          "overlay",
          "enable",
          "--user",
          "0",
          name,
        ]).catch((e) => `failed: ${e instanceof Error ? e.message : e}`);
        console.warn(`enabling ${name} on ${serial}: ${out.trim() || "ok"}`);
      }
    }
    if (Date.now() > end) {
      const overlays = list
        .split("\n")
        .filter((l) => l.includes(`emulation.${DEVICE}`))
        .join("\n");
      // (the whole list would show whether the overlay package is missing or not enabled)
      console.warn(`overlay list of ${serial}:\n${list}`);
      throw new Error(
        `${DEVICE} overlays were not enabled on ${serial} in ${timeoutMs / 1000}s:\n${overlays || "(none listed)"}`,
      );
    }
    await sleep(500);
  }
}

/** pids of emulator processes (launcher or qemu) running the AVD `avd` or using console `port` */
function emulatorPids(avd: string, port: number): number[] {
  const pids: number[] = [];
  for (const entry of fs.readdirSync("/proc")) {
    const pid = Number(entry);
    if (!pid || pid == process.pid) continue;
    let args: string[];
    try {
      args = fs.readFileSync(`/proc/${pid}/cmdline`, "utf-8").split("\0");
    } catch {
      continue;
    }
    if (!/emulator|qemu-system/.test(path.basename(args[0] ?? ""))) continue;
    const arg = (name: string) => {
      const i = args.indexOf(name);
      return i >= 0 ? args[i + 1] : undefined;
    };
    if (arg("-avd") == avd || arg("-port") == `${port}`) pids.push(pid);
  }
  return pids;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Stops the emulator of `avd` / `port`: asks it to quit through adb, then kills any of its processes
 * that are left, and waits until adb no longer lists it.
 */
export async function killEmulator(avd: string, port: number) {
  const serial = `emulator-${port}`;
  const listed = await adbSerials().catch(() => [] as string[]);
  if (listed.includes(serial))
    await adb(serial, ["emu", "kill"]).catch(() => {});

  let end = Date.now() + 15_000;
  while (emulatorPids(avd, port).some(alive) && Date.now() < end)
    await sleep(250);
  for (const pid of emulatorPids(avd, port)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  end = Date.now() + 15_000;
  while (emulatorPids(avd, port).some(alive)) {
    if (Date.now() > end)
      throw new Error(`could not kill the emulator processes of ${avd}`);
    await sleep(250);
  }

  // adb drops a killed emulator after a moment; a stale `offline` entry is harmless but wait for it
  end = Date.now() + 15_000;
  while (
    (await adbSerials().catch(() => [] as string[])).includes(serial) &&
    Date.now() < end
  )
    await sleep(250);
}

/** deletes the AVD's files (including lock files of a crashed emulator) */
export function deleteAvd(avd: string) {
  fs.rmSync(path.join(AVD_HOME, `${avd}.avd`), {
    recursive: true,
    force: true,
  });
  fs.rmSync(path.join(AVD_HOME, `${avd}.ini`), { force: true });
}

async function createAvd(avd: string) {
  deleteAvd(avd);
  fs.mkdirSync(AVD_HOME, { recursive: true });
  const args = [
    "--silent",
    "create",
    "avd",
    "--force",
    "--name",
    avd,
    "--package",
    SYSTEM_IMAGE,
    "--device",
    DEVICE,
    "--path",
    path.join(AVD_HOME, `${avd}.avd`),
  ];
  try {
    await sh(avdmanager(), args, "no\n", toolEnv());
  } catch (e) {
    // one retry from a clean state (e.g. files of a concurrently exiting emulator)
    console.warn(`${e instanceof Error ? e.message : e}\nretrying`);
    await sleep(2000);
    deleteAvd(avd);
    await sh(avdmanager(), args, "no\n", toolEnv());
  }
}

class RendererError extends Error {}

export interface EmulatorOptions {
  /** AVD name, recreated on every start */
  avd: string;
  /** console port (even, 5554-5682), the adb serial is `emulator-<port>` */
  port: number;
  /**
   * renderer: `swiftshader_indirect` (default, software, deterministic for the e2e) or e.g. `host`
   * (host GPU; `auto` falls back to software on Mesa drivers even though `host` works with them)
   */
  gpu?: string;
  /**
   * renderer to boot with instead if `gpu` can't start its renderer (e.g. `host` without a usable
   * GPU driver: the emulator then hangs instead of exiting)
   */
  gpuFallback?: string;
  /** host audio output (default off) */
  audio?: boolean;
  /** virtual CPU cores (default: the device profile's, 4) */
  cores?: number;
  /** guest RAM in MB (default: the device profile's) */
  memoryMb?: number;
}

/**
 * Starts a fresh emulator: kills a leftover one (same AVD or port), recreates the AVD and boots it
 * headless (`-no-window`; the dev script shows it with scrcpy) with wiped data and no snapshots. Resolves once booted. The emulator's output goes to
 * `<tmp>/emulator-<avd>.log`.
 */
export async function startFreshEmulator(
  options: EmulatorOptions,
): Promise<{ serial: string; process: ChildProcess }> {
  const {
    avd,
    port,
    gpu = "swiftshader_indirect",
    gpuFallback,
    audio = false,
    cores,
    memoryMb,
  } = options;
  if (!fs.existsSync(sdkTool(SYSTEM_IMAGE.replaceAll(";", "/"))))
    throw new Error(
      `${SYSTEM_IMAGE} is not installed in ${EMULATOR_SDK} (re-enter shell.nix)`,
    );
  const serial = `emulator-${port}`;
  await sh(ADB, ["start-server"]);
  await killEmulator(avd, port);

  console.log(`creating AVD ${avd} (${SYSTEM_IMAGE})`);
  await createAvd(avd);

  console.log(`starting headless emulator ${avd} as ${serial}`);
  const logFile = path.join(os.tmpdir(), `emulator-${avd}.log`);
  const log = fs.openSync(logFile, "w");
  const child = spawn(
    sdkTool("emulator/emulator"),
    [
      "-avd",
      avd,
      "-port",
      `${port}`,
      "-no-window",
      "-wipe-data",
      "-no-snapshot",
      "-no-snapshot-save",
      "-no-boot-anim",
      "-gpu",
      gpu,
      ...(audio ? [] : ["-no-audio"]),
      ...(cores ? ["-cores", `${cores}`] : []),
      ...(memoryMb ? ["-memory", `${memoryMb}`] : []),
    ],
    { detached: true, stdio: ["ignore", log, log], env: toolEnv() },
  );
  fs.closeSync(log);
  child.unref();

  let onExit = () => {};
  const exited = new Promise<never>((_, reject) => {
    onExit = () => {
      const tail = fs
        .readFileSync(logFile, "utf-8")
        .trim()
        .split("\n")
        .slice(-20)
        .join("\n");
      reject(new Error(`emulator ${avd} exited during boot:\n${tail}`));
    };
    child.once("exit", onExit);
  });
  // a renderer that can't start (e.g. `-gpu host` without a usable GPU driver) leaves the emulator
  // hanging, it never comes up on adb
  let booting = true;
  const rendererFailed = new Promise<never>((_, reject) => {
    const check = () => {
      if (!booting) return;
      const out = fs.readFileSync(logFile, "utf-8");
      if (
        /Could not start renderer|Could not initialize emulated framebuffer/.test(
          out,
        )
      )
        reject(
          new RendererError(
            `emulator ${avd} could not start the ${gpu} renderer`,
          ),
        );
      else setTimeout(check, 500);
    };
    check();
  });
  rendererFailed.catch(() => {}); // only awaited until boot_completed
  try {
    await Promise.race([waitForBoot(serial), exited, rendererFailed]);
    await Promise.race([waitForDeviceOverlays(serial), exited]);
  } catch (e) {
    booting = false;
    child.off("exit", onExit);
    await stopEmulator(avd, port);
    if (e instanceof RendererError && gpuFallback) {
      console.warn(`${e.message}, falling back to -gpu ${gpuFallback}`);
      return startFreshEmulator({
        ...options,
        gpu: gpuFallback,
        gpuFallback: undefined,
      });
    }
    throw e;
  }
  booting = false;
  child.off("exit", onExit);
  return { serial, process: child };
}

/** kills the emulator and deletes its AVD */
export async function stopEmulator(avd: string, port: number) {
  console.log(`stopping emulator ${avd} (emulator-${port})`);
  await killEmulator(avd, port).catch((e) => console.error(e));
  deleteAvd(avd);
}
