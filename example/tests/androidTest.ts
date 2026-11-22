import { test } from "@playwright/test";
import {
  _android as android,
  type AndroidWebView,
  type AndroidDevice,
} from "playwright";
import util from "util";
import child_process from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import { APP_ID, e2eSerial, webViewPage } from "./androidUtil";

const exec = util.promisify(child_process.exec);
const mkdtemp = util.promisify(fs.mkdtemp);

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const androidTest = test.extend<
  {
    meta: {};
  },
  {
    device: AndroidDevice;
    webView: AndroidWebView;
  }
>({
  device: [
    async ({}, use) => {
      // the emulator booted by tests/android.setup.ts (never another attached device)
      const serial = e2eSerial();
      const device = (await android.devices()).find(
        (d) => d.serial() == serial,
      );
      if (!device) throw new Error(`emulator ${serial} not attached`);
      await use(device);
      await device.close();
    },
    { scope: "worker" },
  ],
  webView: [
    async ({ device }, use) => {
      const webView = await device.webView(
        { pkg: APP_ID },
        { timeout: 60_000 },
      );
      await use(webView);
    },
    // not bound by the 30s test timeout
    { scope: "worker", timeout: 90_000 },
  ],
  page: [
    async ({ device, webView }, use) => {
      const page = await webViewPage(device.serial(), webView);
      await use(page);
    },
    { scope: "test" },
  ],
  context: [
    async ({ page }, use) => {
      await use(page.context());
    },
    { scope: "test" },
  ],
  meta: [
    async ({ device, page, context }, use, testInfo) => {
      const localTempDir = await mkdtemp(path.join(os.tmpdir(), "playwright-"));
      const videoLocalFilePath = path.join(localTempDir, `video.mp4`);
      const traceLocalFilePath = path.join(localTempDir, `trace.zip`);
      const videoRemoteFilePath = (await device.shell("mktemp"))
        .toString()
        .trim();

      await page.context().tracing.start({
        sources: true,
        screenshots: true,
        snapshots: true,
      });

      // run in background
      device.shell(`screenrecord ${videoRemoteFilePath}`).finally();

      await use({});

      await context.tracing.stop({ path: traceLocalFilePath });
      await testInfo.attach("trace", { path: traceLocalFilePath });

      await device.shell("pkill -2 screenrecord");
      if (testInfo.error) {
        // wait for recording to finish writing
        await delay(500);
        await exec(`adb pull ${videoRemoteFilePath} ${videoLocalFilePath}`);
      }
      await device.shell(`rm -f ${videoRemoteFilePath}`);
      if (fs.existsSync(videoLocalFilePath))
        await testInfo.attach("video", { path: videoLocalFilePath });

      await fs.promises.rm(localTempDir, { recursive: true });
    },
    { scope: "test", auto: true },
  ],
});
