import { test as setup } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import {
  adb,
  APK_PATH,
  APP_ID,
  AVD_NAME,
  EMULATOR_PORT,
  startFreshEmulator,
  STATE_FILE,
} from "./androidUtil";

// always boots its own fresh *headless* emulator (new AVD, wiped data; other attached devices are
// never used), installs the debug APK and launches the app so its webview can be attached to.
// android.teardown.ts stops it and deletes the AVD.
setup("android device", async () => {
  setup.setTimeout(5 * 60_000);
  const appId = APP_ID;
  if (!fs.existsSync(APK_PATH))
    throw new Error(`APK not found at ${APK_PATH}, run \`pnpm android:apk\``);

  // written before booting so the teardown cleans up after a failed boot too
  const serial = `emulator-${EMULATOR_PORT}`;
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({ serial }));
  await startFreshEmulator({
    avd: AVD_NAME,
    port: EMULATOR_PORT,
  });

  console.log(`installing ${APK_PATH}`);
  await adb(serial, ["install", "-r", "-t", APK_PATH]);

  await adb(serial, ["shell", "am", "force-stop", appId]);
  await adb(serial, [
    "shell",
    "monkey",
    "-p",
    appId,
    "-c",
    "android.intent.category.LAUNCHER",
    "1",
  ]);

  // a cold first launch after install can take a while; wait here (5 min budget) instead of
  // in the test's webView fixture
  const end = Date.now() + 3 * 60_000;
  while (true) {
    const sockets = await adb(serial, ["shell", "cat", "/proc/net/unix"]);
    if (sockets.includes("@webview_devtools_remote_")) break;
    if (Date.now() > end)
      throw new Error(`webview of ${appId} did not start on ${serial}`);
    await new Promise((r) => setTimeout(r, 500));
  }
});
