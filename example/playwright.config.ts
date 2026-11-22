import { defineConfig, devices } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Use the system chromium (NixOS can't run the browsers playwright downloads).
 * Override with PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH.
 */
function getChromiumPath(): string | undefined {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)
    return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  try {
    return (
      execSync("which chromium", { encoding: "utf-8" }).trim() || undefined
    );
  } catch {
    return undefined;
  }
}

/**
 * Playwright's downloaded ffmpeg doesn't run on NixOS. If PLAYWRIGHT_FFMPEG_PATH is set (shell.nix does),
 * build a browsers dir with `ffmpeg-<rev>/ffmpeg-linux` -> that binary, at the revision the installed
 * playwright expects, and point PLAYWRIGHT_BROWSERS_PATH at it. Browsers are launched via
 * `executablePath`, so nothing else is looked up there. Set in the config so forked workers inherit it.
 * Returns whether an ffmpeg is available for video recording.
 */
function setupFfmpeg(): boolean {
  const ffmpeg = process.env.PLAYWRIGHT_FFMPEG_PATH;
  if (!ffmpeg) return !!process.env.PW_VIDEO; // default registry (non-Nix): opt-in
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return true; // already set up (or user override)

  const require = createRequire(import.meta.url);
  const playwrightDir = path.dirname(
    require.resolve("playwright/package.json"),
  );
  const coreDir = path.dirname(
    createRequire(playwrightDir + "/").resolve("playwright-core/package.json"),
  );
  const { browsers } = JSON.parse(
    fs.readFileSync(path.join(coreDir, "browsers.json"), "utf-8"),
  ) as { browsers: { name: string; revision: string }[] };
  const revision = browsers.find((b) => b.name === "ffmpeg")!.revision;

  const browsersDir = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "node_modules/.cache/playwright-nix",
  );
  const link = path.join(browsersDir, `ffmpeg-${revision}`, "ffmpeg-linux");
  let current: string | undefined;
  try {
    current = fs.readlinkSync(link);
  } catch {}
  if (current !== ffmpeg) {
    fs.rmSync(link, { force: true });
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(ffmpeg, link);
  }
  process.env.PLAYWRIGHT_BROWSERS_PATH = browsersDir;
  return true;
}
const videoEnabled = process.env.PW_VIDEO !== "0" && setupFfmpeg();

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: "./tests",
  forbidOnly: !!process.env.CI,
  // no retries: a failure on CI should be reproducible locally, not retried away
  retries: 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://localhost:3000",
    trace: "on",
    // on when an ffmpeg is available (see setupFfmpeg), PW_VIDEO=0 disables it
    video: videoEnabled ? "on" : "off",
  },

  projects: [
    {
      name: "chromium",
      testMatch: "**/chromium.spec.ts",
      fullyParallel: true,
      use: {
        ...devices["Desktop Chrome"],
        headless: true,
        launchOptions: { executablePath: getChromiumPath() },
      },
    },
    // boots a fresh headless emulator (scripts/emulator.ts), installs + launches the app
    {
      name: "android-setup",
      testMatch: "**/android.setup.ts",
      teardown: "android-teardown",
    },
    {
      name: "android-teardown",
      testMatch: "**/android.teardown.ts",
    },
    {
      name: "webview",
      testMatch: "**/android.spec.ts",
      dependencies: ["android-setup"],
      // a single device/webview is shared
      workers: 1,
      use: {
        // tauri serves the bundled app from http://tauri.localhost on android
        baseURL: "http://tauri.localhost",
        // screenrecord/tracing are handled by the androidTest fixture
        video: "off",
      },
    },
    // content-update plugin (tauri-plugin-content-update), restarts/clears the app between tests
    {
      name: "content-update",
      testMatch: "**/contentUpdate.spec.ts",
      // after the webview project, they share the device
      dependencies: ["android-setup", "webview"],
      workers: 1,
      use: { video: "off" },
    },
    // content-update plugin in the linux desktop app, through tauri-driver on a private Xvfb display
    {
      name: "desktop",
      testMatch: "**/contentUpdate.desktop.spec.ts",
      workers: 1,
      use: { video: "off" },
    },
  ],

  webServer: process.env.PW_NO_WEBSERVER
    ? undefined
    : {
        command: "pnpm build && pnpm start",
        url: "http://localhost:3000",
        reuseExistingServer: true,
        timeout: 180_000,
      },
});
