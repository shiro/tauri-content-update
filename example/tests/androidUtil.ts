import type { Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import type { AndroidWebView } from "playwright";
import { adb } from "../scripts/emulator.ts";

export {
  adb,
  ANDROID_API_LEVEL,
  sh,
  startFreshEmulator,
  stopEmulator,
} from "../scripts/emulator.ts";

export const AVD_NAME = process.env.ANDROID_E2E_AVD ?? "playwright-e2e";
export const EMULATOR_PORT = 5580;
const TAURI_CONF = JSON.parse(
  fs.readFileSync(
    path.resolve(import.meta.dirname, "../src-tauri/tauri.conf.json"),
    "utf-8",
  ),
);
/** the app's android package name */
export const APP_ID: string = TAURI_CONF.identifier;
/** the app's (native) version */
export const APP_VERSION: string = TAURI_CONF.version;
/** built by `pnpm android:apk` (debug, x86_64 only for the emulator; tauri names it universal) */
export const APK_PATH = path.resolve(
  import.meta.dirname,
  "../src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk",
);
/** written by android.setup.ts: `{ serial }` of the e2e emulator */
export const STATE_FILE = path.resolve(
  import.meta.dirname,
  "../test-results/.android-e2e.json",
);

/** serial of the emulator started by android.setup.ts */
export const e2eSerial = (): string => {
  if (!fs.existsSync(STATE_FILE))
    throw new Error(`${STATE_FILE} missing, android-setup did not run`);
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")).serial;
};

/**
 * Attaches to the page of an android webview. Playwright's `AndroidWebView.page()` returns the first
 * page of the devtools context right after connecting, and caches `undefined` if the webview hasn't
 * exposed its page target yet (e.g. right after a launch). So first wait until the webview's devtools
 * socket lists a page.
 */
export async function webViewPage(
  serial: string,
  webView: AndroidWebView,
  timeoutMs = 60_000,
): Promise<Page> {
  const port = 9334;
  await adb(serial, [
    "forward",
    `tcp:${port}`,
    `localabstract:webview_devtools_remote_${webView.pid()}`,
  ]);
  try {
    const end = Date.now() + timeoutMs;
    while (true) {
      const targets: { type: string }[] = await fetch(
        `http://127.0.0.1:${port}/json/list`,
      )
        .then((r) => r.json())
        .catch(() => []);
      if (targets.some((t) => t.type == "page")) break;
      if (Date.now() > end)
        throw new Error(
          `webview of pid ${webView.pid()} has no page after ${timeoutMs / 1000}s`,
        );
      await new Promise((r) => setTimeout(r, 250));
    }
  } finally {
    await adb(serial, ["forward", "--remove", `tcp:${port}`]).catch(() => {});
  }
  const page = await webView.page();
  if (!page)
    throw new Error(`could not attach to the page of pid ${webView.pid()}`);
  return page;
}
