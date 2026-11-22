// e2e tests of the content-update plugin (tauri-plugin-content-update) on the emulator.
// A local http server (reachable from the device through `adb reverse`) publishes bundles made with the
// plugin's own bundler; the app is restarted / cleared between steps through adb.
import {
  createBundle,
  nativeApiHash,
} from "tauri-plugin-content-update/bundle";
import { test as base, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _android as android, type AndroidDevice } from "playwright";
import { adb, APK_PATH, APP_ID, e2eSerial, webViewPage } from "./androidUtil";
import {
  appCommand,
  BIG,
  builtinManifest,
  BUILTIN_DIR,
  delay,
  expectRejected,
  makeBundle,
  READY_TIMEOUT,
  SHARED_JS,
  UpdateServer,
  waitFor,
  type BundleOptions,
  type Info,
  type Persisted,
  type State,
} from "./contentUpdateUtil";

const PKG = APP_ID;
/** origin of the app's webview */
const ORIGIN = "http://tauri.localhost";
/** the plugin's data dir, relative to the app's data dir (run-as) */
const DATA_DIR = "content-update";
const PORT = 5591;

// ---------------------------------------------------------------------------------------------
// app control

class App {
  page!: Page;

  constructor(
    readonly device: AndroidDevice,
    readonly serial: string,
  ) {}

  shell = (...args: string[]) => adb(this.serial, ["shell", ...args]);

  async pid() {
    return Number(await this.shell("pidof", PKG).catch(() => "")) || undefined;
  }

  async stop() {
    await this.shell("am", "force-stop", PKG);
    await waitFor(async () => !(await this.pid()), "app to stop");
  }

  /** launches the app (or brings it to the front) and attaches to its webview page */
  async start() {
    await this.shell(
      "monkey",
      "-p",
      PKG,
      "-c",
      "android.intent.category.LAUNCHER",
      "1",
    );
    const pid = await waitFor(() => this.pid(), "app process");
    const webView = await waitFor(
      () =>
        this.device.webViews().find((w) => w.pkg() == PKG && w.pid() == pid),
      `webview of pid ${pid}`,
    );
    const page = await webViewPage(this.serial, webView);
    await page.waitForLoadState();
    this.page = page;
  }

  async restart() {
    await this.stop();
    await this.start();
  }

  /** fresh app data, i.e. the built-in bundle and no content-update state */
  async clear() {
    await this.stop();
    await this.shell("pm", "clear", PKG);
    await this.start();
  }

  /** calls a content-update plugin command through the tauri IPC of the current page */
  async call<T = State>(command: string, args: object = {}): Promise<T> {
    const r = await this.page.evaluate(
      async ([c, a]) => {
        try {
          return {
            ok: await (window as any).__TAURI_INTERNALS__.invoke(
              `plugin:content-update|${c}`,
              a,
            ),
          };
        } catch (e: any) {
          // the plugin rejects with { code, message }
          return { err: { message: String(e?.message ?? e), code: e?.code } };
        }
      },
      [command, args] as const,
    );
    if (r.err)
      throw Object.assign(new Error(`${command}: ${r.err.message}`), {
        code: r.err.code,
      });
    return r.ok as T;
  }

  state = () => this.call<State>("get_state");
  check = (url: string) => this.call<Info>("check", { url });
  download = (url: string, opts: object = {}) =>
    this.call<Info>("download", { url, ...opts });

  /** apply() reloads the page, so don't wait for the answer */
  async apply() {
    await this.page.evaluate(() => {
      void (window as any).__TAURI_INTERNALS__.invoke(
        "plugin:content-update|apply",
      );
    });
  }

  async reset() {
    await this.page.evaluate(() => {
      void (window as any).__TAURI_INTERNALS__.invoke(
        "plugin:content-update|reset",
      );
    });
  }

  /** expects the page to show the given test bundle */
  async expectBundle(version: string, timeout = 15_000) {
    await expect(this.page).toHaveTitle(`bundle ${version}`, { timeout });
    await expect(this.page.locator("#js")).toHaveText("shared.js loaded");
  }

  async expectBuiltin(timeout = 15_000) {
    await expect(this.page).toHaveTitle(/Test/, { timeout });
    await expect(this.page.getByText(/hello\s*world/)).toBeVisible({ timeout });
  }

  /** the plugin's dir, relative to the app's data dir (tauri's app_data_dir) */
  private dataDir?: string;

  private async contentUpdateDir() {
    this.dataDir ??= await waitFor(async () => {
      const found = await this.shell(
        "run-as",
        PKG,
        "sh",
        "-c",
        `'for d in ${DATA_DIR} files/${DATA_DIR}; do [ -f $d/state.json ] && echo $d && break; done'`,
      ).catch(() => "");
      return found.trim() || undefined;
    }, "the content-update dir on the device");
    return this.dataDir;
  }

  /** files below the app's content-update dir (debug APKs allow run-as), state.json excluded */
  async files(): Promise<string[]> {
    const dir = await this.contentUpdateDir();
    const out = await this.shell(
      "run-as",
      PKG,
      "sh",
      "-c",
      `'cd ${dir} 2>/dev/null && find . -type f'`,
    ).catch(() => "");
    return out
      .split("\n")
      .map((l) => l.trim().replace(/^\.\//, ""))
      .filter((f) => f && f != "state.json")
      .sort();
  }

  /** the plugin's persisted state, readable without a page */
  async persisted(): Promise<Persisted> {
    const dir = await this.contentUpdateDir();
    return JSON.parse(
      await this.shell("run-as", PKG, "cat", `${dir}/state.json`),
    );
  }
}

/** the app's modal asking to update the app (src/UpdateRequired.tsx) */
const updateDialog = (page: Page) =>
  page.getByRole("dialog", { name: "Update required" });

// ---------------------------------------------------------------------------------------------
// fixtures

let channels = 0;

const test = base.extend<
  { app: App; channel: string },
  { device: AndroidDevice; server: UpdateServer }
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
  server: [
    async ({ device }, use) => {
      const server = new UpdateServer(PORT);
      await server.listen();
      await adb(device.serial(), ["reverse", `tcp:${PORT}`, `tcp:${PORT}`]);
      await use(server);
      await adb(device.serial(), ["reverse", "--remove", `tcp:${PORT}`]).catch(
        () => {},
      );
      await server.close();
    },
    { scope: "worker" },
  ],
  // every test starts from freshly cleared app data
  app: async ({ device, server }, use) => {
    const app = new App(device, device.serial());
    await app.clear();
    server.requests = [];
    await use(app);
  },
  // a fresh manifest path per test
  channel: async ({}, use) => {
    await use(`c${++channels}`);
  },
});

test.describe.configure({ timeout: 180_000 });

// ---------------------------------------------------------------------------------------------
// tests

test("fresh install runs the built-in bundle, stamped with its version", async ({
  app,
}) => {
  await app.expectBuiltin();
  const state = await app.state();
  expect(state).toMatchObject({
    isBuiltin: true,
    builtinVersion: builtinManifest().version,
    currentVersion: builtinManifest().version,
    nextVersion: null,
    pendingReady: false,
    failedVersions: [],
    incompatibleVersion: null,
  });
  expect(await app.files()).toEqual([]);
  await expect(updateDialog(app.page)).toBeHidden();
});

test("the built-in version is up to date, nothing is downloaded", async ({
  app,
  server,
  channel,
}) => {
  server.publish(channel, builtinManifest());
  expect((await app.check(server.url(channel))).status).toBe("up-to-date");
  expect((await app.download(server.url(channel))).status).toBe("up-to-date");
  expect(server.blobRequests()).toEqual([]);
  expect((await app.state()).nextVersion).toBeNull();
});

test("an update is staged, activated on the next launch and kept once ready", async ({
  app,
  server,
  channel,
}) => {
  const v1 = makeBundle(server, "v1");
  server.publish(channel, v1);

  const info = await app.check(server.url(channel));
  expect(info).toMatchObject({ status: "available", version: "v1" });
  // nothing of the test bundle is in the APK
  expect(info.downloadFiles).toBe(3);
  expect(info.downloadSize).toBe(
    Object.values(v1.files).reduce((a, f) => a + f.size, 0),
  );
  expect(server.blobRequests()).toEqual([]); // check downloads nothing

  expect((await app.download(server.url(channel))).status).toBe("staged");
  expect(server.blobRequests().sort()).toEqual(
    Object.values(v1.files)
      .map((f) => f.sha256)
      .sort(),
  );
  expect(await app.state()).toMatchObject({
    isBuiltin: true,
    nextVersion: "v1",
  });
  expect((await app.check(server.url(channel))).status).toBe("staged");
  // still running the built-in bundle
  await app.expectBuiltin();

  await app.restart();
  await app.expectBundle("v1");
  await expect.poll(async () => (await app.state()).pendingReady).toBe(false);
  expect(await app.state()).toMatchObject({
    currentVersion: "v1",
    isBuiltin: false,
    nextVersion: null,
  });

  // survives restarts, well past the ready timeout
  await delay(READY_TIMEOUT + 2_000);
  await app.restart();
  await app.expectBundle("v1");
  expect((await app.check(server.url(channel))).status).toBe("up-to-date");
});

// apply()/rollbacks/reset() reload the webview; every page must get answers to its IPC calls, the first
// one included (the capacitor version of this plugin hit a bridge race here)
test("the first IPC call after a reload is answered", async ({
  app,
  server,
  channel,
}) => {
  server.publish(channel, makeBundle(server, "v1"));
  await app.download(server.url(channel));
  await app.apply();
  await app.expectBundle("v1");
  for (let i = 0; i < 150; i++) {
    await test.step(`reload ${i}`, async () => {
      const loaded = app.page.waitForEvent("load");
      await app.page.evaluate(() => {
        void (window as any).__TAURI_INTERNALS__.invoke(
          "plugin:content-update|get_state",
        );
        setTimeout(() => location.reload(), 50);
      });
      await loaded;
      await expect
        .poll(() => app.page.evaluate(() => !!(window as any).readyAnswered), {
          timeout: 3_000,
        })
        .toBe(true);
    });
  }
});

test("only changed files are downloaded, the rest is reused from the installed bundle", async ({
  app,
  server,
  channel,
}) => {
  server.publish(channel, makeBundle(server, "v1"));
  await app.download(server.url(channel));
  await app.apply();
  await app.expectBundle("v1");
  await expect.poll(async () => (await app.state()).pendingReady).toBe(false);

  const v2 = makeBundle(server, "v2", { files: { "new.txt": "new file" } });
  server.publish(channel, v2);
  server.requests = [];
  const info = await app.check(server.url(channel));
  expect(info).toMatchObject({ status: "available", downloadFiles: 2 });
  await app.download(server.url(channel));
  // index.html (title changed) and new.txt; shared.js and big.txt are hard-linked from v1
  expect(server.blobRequests().sort()).toEqual(
    [v2.files["index.html"].sha256, v2.files["new.txt"].sha256].sort(),
  );

  // apply() switches right away
  await app.apply();
  await app.expectBundle("v2");
  expect(
    await app.page.evaluate(() => fetch("/new.txt").then((r) => r.text())),
  ).toBe("new file");
  await expect.poll(async () => (await app.state()).pendingReady).toBe(false);
  expect(await app.state()).toMatchObject({
    currentVersion: "v2",
    nextVersion: null,
  });
  // v1 is cleaned up once v2 is confirmed
  await expect
    .poll(async () =>
      (await app.files()).filter((f) => f.startsWith("bundles/v1/")),
    )
    .toEqual([]);
  expect(
    (await app.files()).filter((f) => f.startsWith("bundles/v2/")).sort(),
  ).toEqual(
    [
      "assets/big.txt",
      "content-update.json",
      "index.html",
      "new.txt",
      "shared.js",
    ].map((f) => `bundles/v2/${f}`),
  );
});

test("files are reused from the app's embedded built-in bundle", async ({
  app,
  server,
  channel,
}) => {
  // the real app as an update: same files as the built-in bundle, another version
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "content-update-app-"));
  fs.cpSync(BUILTIN_DIR, dir, { recursive: true });
  const manifest = createBundle(dir, {
    outDir: server.blobs,
    version: "app-copy",
  });
  fs.rmSync(dir, { recursive: true });
  server.publish(channel, manifest);
  // it uses the app's own native API: its command (through the generated bindings) and the plugin
  // commands, so it's compatible
  expect(manifest.requires).toEqual(builtinManifest().requires);
  expect(manifest.requires).toEqual(
    expect.arrayContaining([
      appCommand("app_info").split(":")[2],
      nativeApiHash("plugin:content-update|notify_ready"),
    ]),
  );

  expect(await app.check(server.url(channel))).toMatchObject({
    status: "available",
    downloadFiles: 0,
    downloadSize: 0,
  });
  expect((await app.download(server.url(channel))).status).toBe("staged");
  expect(server.blobRequests()).toEqual([]);

  await app.apply();
  await app.expectBuiltin();
  expect((await app.state()).currentVersion).toBe("app-copy");
  // the app itself calls notifyReady (entry-client.tsx -> sync())
  await expect.poll(async () => (await app.state()).pendingReady).toBe(false);
  await app.restart();
  await app.expectBuiltin();
  expect((await app.state()).currentVersion).toBe("app-copy");
});

test("a bundle that never calls notifyReady is rolled back after the timeout", async ({
  app,
  server,
  channel,
}) => {
  server.publish(channel, makeBundle(server, "good"));
  await app.download(server.url(channel));
  await app.apply();
  await app.expectBundle("good");
  await expect.poll(async () => (await app.state()).pendingReady).toBe(false);

  server.publish(channel, makeBundle(server, "bad", { ready: false }));
  await app.download(server.url(channel));
  await app.apply();
  await app.expectBundle("bad");
  expect((await app.state()).pendingReady).toBe(true);

  // back to the last good bundle, without a restart
  await app.expectBundle("good", READY_TIMEOUT + 10_000);
  expect(await app.state()).toMatchObject({
    currentVersion: "good",
    pendingReady: false,
    failedVersions: ["bad"],
  });

  // not offered again...
  expect((await app.check(server.url(channel))).status).toBe("failed");
  server.requests = [];
  expect((await app.download(server.url(channel))).status).toBe("failed");
  expect(server.blobRequests()).toEqual([]);
  // ...unless forced
  expect(
    (await app.download(server.url(channel), { force: true })).status,
  ).toBe("staged");
  expect((await app.state()).failedVersions).toEqual([]);

  // the forced download is activated on the next launch
  await app.restart();
  await app.expectBundle("bad");
});

test("a rollback from a bad first update goes back to the built-in bundle", async ({
  app,
  server,
  channel,
}) => {
  server.publish(channel, makeBundle(server, "bad", { ready: false }));
  await app.download(server.url(channel));
  await app.restart();
  await app.expectBundle("bad");
  await app.expectBuiltin(READY_TIMEOUT + 10_000);
  expect(await app.state()).toMatchObject({
    isBuiltin: true,
    failedVersions: ["bad"],
  });
  await app.restart();
  await app.expectBuiltin();
  // the failed bundle's files are removed
  await expect.poll(() => app.files()).toEqual([]);
});

test("a bundle whose process dies before notifyReady is rolled back on the next launch", async ({
  app,
  server,
  channel,
}) => {
  server.publish(channel, makeBundle(server, "good"));
  await app.download(server.url(channel));
  await app.restart();
  await app.expectBundle("good");
  await expect.poll(async () => (await app.state()).pendingReady).toBe(false);

  server.publish(channel, makeBundle(server, "crashy", { ready: false }));
  await app.download(server.url(channel));
  await app.restart();
  await app.expectBundle("crashy");
  // "crash" well within the ready timeout
  await app.stop();
  expect((await app.persisted()).trial).toBe(true);

  await app.start();
  await app.expectBundle("good");
  expect(await app.state()).toMatchObject({
    currentVersion: "good",
    pendingReady: false,
    failedVersions: ["crashy"],
  });
});

/**
 * Evaluates `expression` in the app's attached page through a raw CDP connection to the process' devtools
 * socket. After an activity recreation tauri creates a new webview in the same process (the old one stays
 * around detached, its page no longer runs), which playwright's android webview doesn't pick up, and the
 * webview doesn't support playwright's connectOverCDP.
 */
async function cdpEvaluate(app: App, pid: number, expression: string) {
  const port = 9333;
  await adb(app.serial, [
    "forward",
    `tcp:${port}`,
    `localabstract:webview_devtools_remote_${pid}`,
  ]);
  try {
    const targets: {
      type: string;
      url: string;
      description: string;
      webSocketDebuggerUrl: string;
    }[] = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) =>
      r.json(),
    );
    const target = targets.find(
      (t) =>
        t.type == "page" &&
        t.url.startsWith(ORIGIN) &&
        JSON.parse(t.description || "{}").attached,
    );
    if (!target) return undefined;
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    try {
      await new Promise(
        (resolve, reject) => ((ws.onopen = resolve), (ws.onerror = reject)),
      );
      const reply = new Promise<any>((resolve, reject) => {
        ws.onmessage = (m) => resolve(JSON.parse(String(m.data)));
        setTimeout(() => reject(new Error("CDP evaluate timed out")), 5_000);
      });
      ws.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      );
      return (await reply).result?.result?.value;
    } finally {
      ws.close();
    }
  } finally {
    await adb(app.serial, ["forward", "--remove", `tcp:${port}`]).catch(
      () => {},
    );
  }
}

/**
 * Recreates the activity (a font scale change isn't in its configChanges) and waits for the relaunch.
 * `fn` gets an evaluate function for the page of the new activity (over CDP, see cdpEvaluate).
 */
async function withRecreatedActivity(
  app: App,
  fn: (evaluate: (expression: string) => Promise<any>) => Promise<void>,
) {
  const pid = (await app.pid())!;
  await adb(app.serial, ["logcat", "-c"]);
  await app.shell("settings", "put", "system", "font_scale", "1.15");
  try {
    await waitFor(
      async () =>
        (
          await adb(app.serial, ["logcat", "-d", "-s", "WindowManager:I"])
        ).match(new RegExp(`relaunch: Window\\{\\S+ \\S+ ${PKG}/`)),
      "the activity relaunch",
      10_000,
    );
    expect(await app.pid()).toBe(pid);
    await fn((expression) =>
      waitFor(
        () => cdpEvaluate(app, pid, expression).catch(() => undefined),
        "the page of the new activity",
        10_000,
      ),
    );
  } finally {
    await app.shell("settings", "put", "system", "font_scale", "1.0");
  }
}

/** title, shared.js marker and plugin state of the current page */
const PAGE_STATE = `document.readyState == "complete" &&
  window.__TAURI_INTERNALS__.invoke("plugin:content-update|get_state")
    .then((state) => ({ title: document.title, js: document.getElementById("js")?.textContent, state }))`;

test("recreating the activity doesn't count as a failed launch", async ({
  app,
  server,
  channel,
}) => {
  server.publish(channel, makeBundle(server, "slow", { ready: false }));
  await app.download(server.url(channel));
  await app.apply();
  await app.expectBundle("slow");
  const appliedAt = Date.now();

  await withRecreatedActivity(app, async (evaluate) => {
    // still the trial bundle, no rollback or restart
    expect(await evaluate(PAGE_STATE)).toMatchObject({
      title: "bundle slow",
      js: "shared.js loaded",
      state: { currentVersion: "slow", pendingReady: true },
    });
    expect(await app.persisted()).toMatchObject({
      current: "slow",
      trial: true,
    });
    expect(Date.now() - appliedAt).toBeLessThan(READY_TIMEOUT);

    // the trial timer survives the recreation: still no notifyReady -> rolled back, on time
    await waitFor(
      async () => (await app.persisted()).current == null,
      "the rollback",
      READY_TIMEOUT + 5_000,
    );
    expect(Date.now() - appliedAt).toBeGreaterThanOrEqual(
      READY_TIMEOUT - 1_000,
    );
    expect(await app.persisted()).toMatchObject({
      trial: false,
      failed: ["slow"],
    });
    // the rollback reloaded the new activity's webview into the built-in bundle
    await waitFor(
      async () => (await evaluate(PAGE_STATE))?.title == "Test" || undefined,
      "the new webview to show the built-in bundle",
    );
  });
});

test("a confirmed bundle survives an activity recreation", async ({
  app,
  server,
  channel,
}) => {
  server.publish(channel, makeBundle(server, "v1"));
  await app.download(server.url(channel));
  await app.apply();
  await app.expectBundle("v1");
  await expect.poll(async () => (await app.state()).pendingReady).toBe(false);

  await withRecreatedActivity(app, async (evaluate) => {
    expect(await evaluate(PAGE_STATE)).toMatchObject({
      title: "bundle v1",
      js: "shared.js loaded",
      state: { currentVersion: "v1", pendingReady: false, failedVersions: [] },
    });
  });
  // and after a restart
  await app.restart();
  await app.expectBundle("v1");
});

test("a corrupted file fails the download and leaves the app untouched", async ({
  app,
  server,
  channel,
}) => {
  const v1 = makeBundle(server, "v1");
  server.publish(channel, v1);
  server.fault(v1.files["shared.js"].sha256, (_, res) => {
    res.writeHead(200);
    res.end(SHARED_JS.replace("loaded", "LOADED")); // same size, different content
  });
  await expectRejected(
    app.download(server.url(channel)),
    "DOWNLOAD_FAILED",
    /checksum mismatch for shared\.js/,
  );
  expect(await app.state()).toMatchObject({
    isBuiltin: true,
    nextVersion: null,
  });
  expect((await app.files()).filter((f) => f.startsWith("bundles/"))).toEqual(
    [],
  );
  await app.restart();
  await app.expectBuiltin();
});

test("an interrupted download resumes with the missing files only", async ({
  app,
  server,
  channel,
}) => {
  const v1 = makeBundle(server, "v1");
  server.publish(channel, v1);
  const big = v1.files["assets/big.txt"].sha256;
  // big.txt: the connection drops halfway
  server.fault(big, (_, res) => {
    res.writeHead(200, { "content-length": String(BIG.length) });
    res.write(BIG.slice(0, BIG.length / 2));
    setTimeout(() => res.destroy(), 100);
  });
  await expectRejected(app.download(server.url(channel)), "DOWNLOAD_FAILED");
  expect((await app.state()).nextVersion).toBeNull();
  // the other files are kept in the staging dir
  const staged = (await app.files()).filter((f) => f.startsWith("staging/v1/"));
  expect(staged).toContain("staging/v1/index.html");
  expect(staged.some((f) => f.endsWith(".part"))).toBe(false);

  server.requests = [];
  expect((await app.download(server.url(channel))).status).toBe("staged");
  expect(server.blobRequests()).toEqual([big]);
  await app.apply();
  await app.expectBundle("v1");
  expect(
    await app.page.evaluate(() =>
      fetch("/assets/big.txt").then((r) => r.text()),
    ),
  ).toBe(BIG);
  expect((await app.files()).filter((f) => f.startsWith("staging/"))).toEqual(
    [],
  );
});

test("a download interrupted by the process dying resumes after a restart", async ({
  app,
  server,
  channel,
}) => {
  const v1 = makeBundle(server, "v1");
  server.publish(channel, v1);
  const big = v1.files["assets/big.txt"].sha256;
  // big.txt trickles in until the app gets killed
  server.fault(big, (_, res) => {
    res.writeHead(200, { "content-length": String(BIG.length) });
    res.write(BIG.slice(0, 1024));
  });
  void app.download(server.url(channel)).catch(() => {});
  await waitFor(
    async () => (await app.files()).includes("staging/v1/assets/big.txt.part"),
    "the download to start",
  );
  await waitFor(
    async () => (await app.files()).includes("staging/v1/index.html"),
    "the small files to finish",
  );
  await app.stop();

  await app.start();
  await app.expectBuiltin();
  expect((await app.state()).nextVersion).toBeNull();
  server.requests = [];
  expect((await app.download(server.url(channel))).status).toBe("staged");
  expect(server.blobRequests()).toEqual([big]);
  expect((await app.files()).filter((f) => f.startsWith("staging/"))).toEqual(
    [],
  );
  await app.restart();
  await app.expectBundle("v1");
});

test("server errors and oversized files fail the download", async ({
  app,
  server,
  channel,
}) => {
  const v1 = makeBundle(server, "v1");
  server.publish(channel, v1);
  const sha = v1.files["shared.js"].sha256;
  server.fault(
    sha,
    (_, res) => res.writeHead(500).end("boom"),
    (_, res) => res.writeHead(200).end(SHARED_JS + "// more than declared"),
    (_, res) => res.writeHead(200).end(SHARED_JS.slice(1)),
  );
  await expectRejected(
    app.download(server.url(channel)),
    "DOWNLOAD_FAILED",
    /HTTP 500/,
  );
  await expectRejected(
    app.download(server.url(channel)),
    "DOWNLOAD_FAILED",
    /larger than its declared size/,
  );
  await expectRejected(
    app.download(server.url(channel)),
    "DOWNLOAD_FAILED",
    /expected/,
  );
  expect((await app.download(server.url(channel))).status).toBe("staged");
});

test("unreachable and broken manifests are rejected", async ({
  app,
  server,
  channel,
}) => {
  // no server on that port
  await expectRejected(
    app.check("http://localhost:1/manifest.json"),
    "CHECK_FAILED",
  );
  // 404
  await expectRejected(
    app.check(server.url("nope")),
    "CHECK_FAILED",
    /HTTP 404/,
  );
  await expectRejected(
    app.download(server.url("nope")),
    "DOWNLOAD_FAILED",
    /HTTP 404/,
  );
  // no url at all (none configured)
  await expectRejected(app.call("check"), "NO_URL");

  const valid = makeBundle(server, "v1");
  const sha = valid.files["index.html"].sha256;
  const cases: [string, string, RegExp][] = [
    ["not json", "{", /invalid manifest/],
    ["no files", JSON.stringify({ version: "v1" }), /missing files/],
    [
      "no index.html",
      JSON.stringify({
        version: "v1",
        files: { "a.js": { sha256: sha, size: 1 } },
      }),
      /no index\.html/,
    ],
    [
      "bad version",
      JSON.stringify({ ...valid, version: "../v1" }),
      /invalid manifest version/,
    ],
    [
      "empty version",
      JSON.stringify({ ...valid, version: "" }),
      /invalid manifest version/,
    ],
    [
      "bad sha",
      JSON.stringify({
        ...valid,
        files: { ...valid.files, "index.html": { sha256: "abc", size: 1 } },
      }),
      /invalid sha256/,
    ],
    [
      "bad size",
      JSON.stringify({
        ...valid,
        files: { ...valid.files, "index.html": { sha256: sha, size: -1 } },
      }),
      /invalid size/,
    ],
    [
      "requires not a list",
      JSON.stringify({ ...valid, requires: "0123456789ab" }),
      /requires is not an array/,
    ],
    [
      "bad native API hash",
      JSON.stringify({ ...valid, requires: ["0123456789AB"] }),
      /invalid native API hash/,
    ],
    [
      "reserved file",
      JSON.stringify({
        ...valid,
        files: {
          ...valid.files,
          "content-update.json": { sha256: sha, size: 1 },
        },
      }),
      /reserved path/,
    ],
  ];
  for (const [name, body, message] of cases) {
    server.publish(channel, body);
    await test.step(name, async () => {
      await expectRejected(
        app.check(server.url(channel)),
        "CHECK_FAILED",
        message,
      );
      await expectRejected(
        app.download(server.url(channel)),
        "DOWNLOAD_FAILED",
        message,
      );
    });
  }
  expect(server.blobRequests()).toEqual([]);
  expect(await app.state()).toMatchObject({
    isBuiltin: true,
    nextVersion: null,
  });
  await app.expectBuiltin();
});

test("paths escaping the bundle are refused", async ({
  app,
  server,
  channel,
}) => {
  const valid = makeBundle(server, "v1");
  const evil = {
    sha256: valid.files["shared.js"].sha256,
    size: valid.files["shared.js"].size,
  };
  for (const p of [
    "../../state.json",
    "../evil.js",
    "a/../../evil.js",
    "/data/local/tmp/evil.js",
    "a//b.js",
    "./a.js",
    "a\\..\\evil.js",
  ]) {
    await test.step(p, async () => {
      server.publish(channel, {
        ...valid,
        files: { ...valid.files, [p]: evil },
      });
      await expectRejected(
        app.download(server.url(channel)),
        "DOWNLOAD_FAILED",
        /invalid path/,
      );
    });
  }
  expect(server.blobRequests()).toEqual([]);
  expect(await app.files()).toEqual([]);
  expect((await app.persisted()).next ?? null).toBeNull();
});

test("a bundle needing a newer native version isn't installed, and the app asks for an update", async ({
  app,
  server,
  channel,
}) => {
  const { nativeVersionCode } = await app.state();
  server.publish(
    channel,
    makeBundle(server, "future", { minNativeVersion: nativeVersionCode + 1 }),
  );
  expect(await app.check(server.url(channel))).toMatchObject({
    status: "incompatible",
    reason: "nativeVersion",
    version: "future",
  });
  // not even forced (that's for failed versions)
  expect(
    (await app.download(server.url(channel), { force: true })).status,
  ).toBe("incompatible");
  expect(server.blobRequests()).toEqual([]);
  expect(await app.state()).toMatchObject({
    isBuiltin: true,
    nextVersion: null,
    incompatibleVersion: "future",
  });

  // remembered: the app shows its update modal on the next launch, offline too (the app has no
  // manifest url configured, its own sync() doesn't check)
  await app.restart();
  await expect(updateDialog(app.page)).toBeVisible();
  // which can't be dismissed
  await app.page.keyboard.press("Escape");
  await app.page.keyboard.press("Escape");
  await expect(updateDialog(app.page)).toBeVisible();

  // a version this app can run is published again
  server.publish(
    channel,
    makeBundle(server, "current", { minNativeVersion: nativeVersionCode }),
  );
  expect((await app.check(server.url(channel))).status).toBe("available");
  expect((await app.state()).incompatibleVersion).toBeNull();
  await app.restart();
  await app.expectBuiltin();
  await expect(updateDialog(app.page)).toBeHidden();
  expect((await app.download(server.url(channel))).status).toBe("staged");
});

test("a bundle using native API the app doesn't provide isn't installed", async ({
  app,
  server,
  channel,
}) => {
  const uses = (code: string): BundleOptions => ({
    files: { "api.js": code },
  });
  const cases: [string, BundleOptions][] = [
    [
      "an app command with another signature",
      uses(`call("${appCommand("app_info", "0123456789ab")}")`),
    ],
    ["a plugin the app doesn't have", uses(`invoke("plugin:fs|read_file")`)],
    ["a command no capability allows", uses(`invoke("plugin:window|close")`)],
  ];
  for (const [i, [name, options]] of cases.entries()) {
    await test.step(name, async () => {
      server.publish(channel, makeBundle(server, `missing${i}`, options));
      expect(await app.check(server.url(channel))).toMatchObject({
        status: "incompatible",
        reason: "nativeApi",
      });
      expect((await app.download(server.url(channel))).status).toBe(
        "incompatible",
      );
      expect((await app.state()).incompatibleVersion).toBe(`missing${i}`);
    });
  }
  expect(server.blobRequests()).toEqual([]);

  // the app's command with its current signature, and a command the capability allows that the
  // built-in bundle doesn't use
  server.publish(
    channel,
    makeBundle(
      server,
      "provided",
      uses(`call("${appCommand("app_info")}"); invoke("plugin:app|version")`),
    ),
  );
  expect((await app.check(server.url(channel))).status).toBe("available");
  expect((await app.state()).incompatibleVersion).toBeNull();
  expect((await app.download(server.url(channel))).status).toBe("staged");
  await app.apply();
  await app.expectBundle("provided");
  await expect.poll(async () => (await app.state()).pendingReady).toBe(false);
});

test("publishing the built-in version again switches back to it without downloading", async ({
  app,
  server,
  channel,
}) => {
  server.publish(channel, makeBundle(server, "v1"));
  await app.download(server.url(channel));
  await app.apply();
  await app.expectBundle("v1");
  await expect.poll(async () => (await app.state()).pendingReady).toBe(false);

  server.publish(channel, builtinManifest());
  server.requests = [];
  expect((await app.download(server.url(channel))).status).toBe("staged");
  expect(server.blobRequests()).toEqual([]);
  expect((await app.state()).nextVersion).toBe(builtinManifest().version);
  await app.restart();
  await app.expectBuiltin();
  expect(await app.state()).toMatchObject({
    isBuiltin: true,
    pendingReady: false,
  });
  await expect.poll(() => app.files()).toEqual([]);
});

test("a version republished with different files is installed fresh", async ({
  app,
  server,
  channel,
}) => {
  server.publish(channel, makeBundle(server, "v1"));
  await app.download(server.url(channel));
  // same version, different index.html; v1 is only staged, not running
  server.publish(channel, makeBundle(server, "v1", { salt: "rebuilt" }));
  expect((await app.check(server.url(channel))).status).toBe("staged");
  // staged means "same version", so download() doesn't replace it ...
  expect((await app.download(server.url(channel))).status).toBe("staged");
  // ... but a reset + download installs the new files
  await app.reset();
  await app.expectBuiltin();
  expect((await app.download(server.url(channel))).status).toBe("staged");
  await app.apply();
  await app.expectBundle("v1");
  expect(await app.page.content()).toContain("rebuilt");
});

test("reset() goes back to the built-in bundle", async ({
  app,
  server,
  channel,
}) => {
  server.publish(channel, makeBundle(server, "v1"));
  await app.download(server.url(channel));
  await app.apply();
  await app.expectBundle("v1");
  await app.reset();
  await app.expectBuiltin();
  expect(await app.state()).toMatchObject({
    isBuiltin: true,
    nextVersion: null,
    pendingReady: false,
  });
  await expect.poll(() => app.files()).toEqual([]);
  await app.restart();
  await app.expectBuiltin();
});

test("installing a new APK drops downloaded bundles and the update request", async ({
  app,
  server,
  channel,
}) => {
  server.publish(channel, makeBundle(server, "v1"));
  await app.download(server.url(channel));
  await app.apply();
  await app.expectBundle("v1");
  await expect.poll(async () => (await app.state()).pendingReady).toBe(false);
  // the old app learned that it needs an update
  server.publish(
    channel,
    makeBundle(server, "v2", { nativeApi: ["plugin:fs|read_file"] }),
  );
  expect((await app.check(server.url(channel))).status).toBe("incompatible");

  await app.stop();
  await adb(app.serial, ["install", "-r", "-t", APK_PATH]);
  await app.start();
  await app.expectBuiltin();
  // the new app checks again itself (sync()) before asking for an update
  expect(await app.state()).toMatchObject({
    isBuiltin: true,
    failedVersions: [],
    incompatibleVersion: null,
  });
  await expect(updateDialog(app.page)).toBeHidden();
  expect(await app.files()).toEqual([]);
});

test("progress events, concurrent downloads, unusual file names and deep links", async ({
  app,
  server,
  channel,
}) => {
  const v1 = makeBundle(server, "v1", {
    files: { "dir with space/ü ñ.txt": "unicode", "a/b/c/deep.txt": "deep" },
  });
  server.publish(channel, v1);
  // slow down big.txt so the second download overlaps
  server.fault(v1.files["assets/big.txt"].sha256, (_, res) => {
    res.writeHead(200);
    let i = 0;
    const chunk = 64 * 1024;
    const timer = setInterval(() => {
      res.write(BIG.slice(i, i + chunk));
      i += chunk;
      if (i >= BIG.length) {
        clearInterval(timer);
        res.end();
      }
    }, 150);
  });

  // what `listen()` of @tauri-apps/api/event does
  await app.page.evaluate(async () => {
    const tauri = (window as any).__TAURI_INTERNALS__;
    (window as any).progress = [];
    await tauri.invoke("plugin:event|listen", {
      event: "content-update://download-progress",
      target: { kind: "Any" },
      handler: tauri.transformCallback((e: any) =>
        (window as any).progress.push(e.payload),
      ),
    });
  });
  const first = app.download(server.url(channel));
  await delay(300);
  await expectRejected(app.download(server.url(channel)), "BUSY");
  expect((await first).status).toBe("staged");

  const progress: any[] = await app.page.evaluate(
    () => (window as any).progress,
  );
  const total = Object.values(v1.files).reduce((a, f) => a + f.size, 0);
  expect(progress.length).toBeGreaterThan(2);
  expect(progress.at(-1)).toMatchObject({
    version: "v1",
    loaded: total,
    total,
    files: 5,
    totalFiles: 5,
  });
  for (let i = 1; i < progress.length; i++)
    expect(progress[i].loaded).toBeGreaterThanOrEqual(progress[i - 1].loaded);

  await app.apply();
  await app.expectBundle("v1");
  const fetchText = (u: string) =>
    app.page.evaluate((u) => fetch(u).then((r) => r.text()), u);
  expect(await fetchText("/dir%20with%20space/%C3%BC%20%C3%B1.txt")).toBe(
    "unicode",
  );
  expect(await fetchText("/a/b/c/deep.txt")).toBe("deep");
  // SPA routes fall back to the bundle's index.html
  await app.page.goto(`${ORIGIN}/some/client/route`);
  await app.expectBundle("v1");
});
