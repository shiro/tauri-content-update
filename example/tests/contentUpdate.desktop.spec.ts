// e2e tests of the content-update plugin in the linux desktop app (`pnpm desktop:build`), driven through
// tauri-driver (WebKitWebDriver) on a private Xvfb display: never on the user's screen.
// The android suite (contentUpdate.spec.ts) covers the plugin's logic in depth; this one covers what differs
// on desktop: serving bundles through the `tauri://` protocol, the binary identity, restarts and the
// data dir.
import { createBundle } from "tauri-plugin-content-update/bundle";
import { test as base, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { APP_ID, APP_VERSION } from "./androidUtil";
import {
  appCommand,
  builtinManifest,
  BUILTIN_DIR,
  delay,
  makeBundle,
  READY_TIMEOUT,
  UpdateServer,
  waitFor,
  type Info,
  type Persisted,
  type State,
} from "./contentUpdateUtil";
import { WebDriverSession } from "./webdriver";

/** built by `pnpm desktop:build` (debug, embeds the stamped frontendDist) */
const DESKTOP_BIN = path.resolve(
  import.meta.dirname,
  "../src-tauri/target/debug/app",
);
const PORT = 5592;
const DRIVER_PORT = 4445;

const freePort = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = net.createServer().once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });

/**
 * tauri-driver on its own Xvfb display (`xvfb-run -a`). The wayland socket is removed from the env and GDK
 * forced to x11, otherwise GTK would open the app's window on the user's wayland session.
 */
class Driver {
  readonly dataHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "content-update-desktop-"),
  );
  private child?: ChildProcess;

  async start() {
    if (!fs.existsSync(DESKTOP_BIN))
      throw new Error(`${DESKTOP_BIN} not found, run \`pnpm desktop:build\``);
    if (!(await freePort(DRIVER_PORT)))
      throw new Error(
        `port ${DRIVER_PORT} is in use (a leftover tauri-driver?)`,
      );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GDK_BACKEND: "x11",
      // isolated app data (tauri's app_data_dir is $XDG_DATA_HOME/<identifier>)
      XDG_DATA_HOME: this.dataHome,
    };
    delete env.WAYLAND_DISPLAY;
    delete env.DISPLAY; // set by xvfb-run
    this.child = spawn(
      "xvfb-run",
      [
        "-a",
        "tauri-driver",
        "--port",
        String(DRIVER_PORT),
        "--native-port",
        String(DRIVER_PORT + 1),
      ],
      { env, detached: true, stdio: "ignore" },
    );
    await waitFor(
      async () => !(await freePort(DRIVER_PORT)),
      "tauri-driver",
      20_000,
    );
  }

  async stop() {
    // xvfb-run, Xvfb, tauri-driver, WebKitWebDriver and the app share the process group
    if (this.child?.pid) {
      try {
        process.kill(-this.child.pid, "SIGTERM");
      } catch {}
      await delay(500);
      try {
        process.kill(-this.child.pid, "SIGKILL");
      } catch {}
    }
    fs.rmSync(this.dataHome, { recursive: true, force: true });
  }

  get server() {
    return `http://127.0.0.1:${DRIVER_PORT}`;
  }
}

/** pids of the desktop app (the test binary, by path) */
function appPids(): number[] {
  return fs
    .readdirSync("/proc")
    .filter((p) => /^\d+$/.test(p))
    .filter((p) => {
      try {
        return fs.readlinkSync(`/proc/${p}/exe`) == DESKTOP_BIN;
      } catch {
        return false;
      }
    })
    .map(Number);
}

class DesktopApp {
  session?: WebDriverSession;

  constructor(readonly driver: Driver) {}

  get dataDir() {
    return path.join(this.driver.dataHome, APP_ID, "content-update");
  }

  async start() {
    this.session = await WebDriverSession.create(
      this.driver.server,
      DESKTOP_BIN,
    );
    // headless guard: the app must only see the Xvfb display
    for (const pid of appPids()) {
      const env = fs.readFileSync(`/proc/${pid}/environ`, "utf-8").split("\0");
      expect(env.some((e) => e.startsWith("WAYLAND_DISPLAY="))).toBe(false);
      expect(env).toContain("GDK_BACKEND=x11");
    }
  }

  /** closes the app (ends the session) */
  async stop() {
    await this.session?.delete().catch(() => {});
    this.session = undefined;
    await waitFor(
      () => appPids().length == 0 || undefined,
      "the app to exit",
      10_000,
    ).catch(() => this.kill());
  }

  /** "crash": SIGKILL */
  async kill() {
    for (const pid of appPids()) process.kill(pid, "SIGKILL");
    await waitFor(() => appPids().length == 0 || undefined, "the app to die");
    await this.session?.delete().catch(() => {});
    this.session = undefined;
  }

  async restart() {
    await this.stop();
    await this.start();
  }

  async clear() {
    await this.stop();
    fs.rmSync(path.join(this.driver.dataHome, APP_ID), {
      recursive: true,
      force: true,
    });
    await this.start();
  }

  async call<T = State>(command: string, args: object = {}): Promise<T> {
    const r = await this.session!.executeAsync<{ ok?: T; err?: any }>(
      `const done = arguments[arguments.length - 1];
       window.__TAURI_INTERNALS__.invoke("plugin:content-update|" + arguments[0], arguments[1])
         .then((ok) => done({ ok }), (err) => done({ err }));`,
      [command, args],
    );
    if (r.err)
      throw Object.assign(new Error(`${command}: ${r.err.message ?? r.err}`), {
        code: r.err.code,
      });
    return r.ok as T;
  }

  state = () => this.call<State>("get_state");
  download = (url: string, opts: object = {}) =>
    this.call<Info>("download", { url, ...opts });

  /** fire and forget: these reload the page */
  async invokeNoWait(command: string) {
    await this.session!.execute(
      `window.__TAURI_INTERNALS__.invoke("plugin:content-update|" + arguments[0]); return null;`,
      [command],
    );
  }

  /** title, the test bundles' shared.js marker, text and whether a modal is open, once loaded */
  page() {
    return this.session!.execute<{
      title: string;
      js?: string;
      text: string;
      modal: boolean;
    } | null>(
      `if (document.readyState != "complete") return null;
       return {
         title: document.title,
         js: document.getElementById("js")?.textContent,
         text: document.body.innerText,
         modal: !!document.querySelector("dialog:modal"),
       };`,
    ).catch(() => null);
  }

  async expectBundle(version: string, timeout = 15_000) {
    await waitFor(
      async () => {
        const p = await this.page();
        return (
          (p?.title == `bundle ${version}` && p.js == "shared.js loaded") ||
          undefined
        );
      },
      `bundle ${version}`,
      timeout,
    );
  }

  async expectBuiltin(timeout = 15_000) {
    await waitFor(
      async () => {
        const p = await this.page();
        return (
          (p?.title == "Test" && /hello\s*world/.test(p.text)) || undefined
        );
      },
      "the built-in bundle",
      timeout,
    );
  }

  persisted(): Persisted {
    return JSON.parse(
      fs.readFileSync(path.join(this.dataDir, "state.json"), "utf-8"),
    );
  }

  /** installed bundle dirs */
  bundles(): string[] {
    const dir = path.join(this.dataDir, "bundles");
    return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
  }
}

let channels = 0;

const test = base.extend<
  { app: DesktopApp; channel: string },
  { driver: Driver; server: UpdateServer }
>({
  driver: [
    async ({}, use) => {
      const driver = new Driver();
      await driver.start();
      await use(driver);
      await driver.stop();
    },
    { scope: "worker" },
  ],
  server: [
    async ({}, use) => {
      const server = new UpdateServer(PORT);
      await server.listen();
      await use(server);
      await server.close();
    },
    { scope: "worker" },
  ],
  app: async ({ driver, server }, use) => {
    const app = new DesktopApp(driver);
    await app.clear();
    server.requests = [];
    await use(app);
    await app.stop();
  },
  channel: async ({}, use) => {
    await use(`d${++channels}`);
  },
});

test.describe.configure({ timeout: 120_000 });

test("the built-in bundle is served, stamped with its version", async ({
  app,
}) => {
  await app.expectBuiltin();
  expect(await app.state()).toMatchObject({
    isBuiltin: true,
    builtinVersion: builtinManifest().version,
    pendingReady: false,
    incompatibleVersion: null,
  });
  // an app command, called through the generated bindings
  await waitFor(
    async () =>
      (await app.page())?.text.includes(`native ${APP_VERSION} (linux)`),
    "the native info",
  );
  expect((await app.page())?.modal).toBe(false);
});

test("an update is downloaded, activated on the next launch and served from disk", async ({
  app,
  server,
  channel,
}) => {
  const v1 = makeBundle(server, "v1", {
    files: { "dir with space/ü ñ.txt": "unicode", "a/b/c/deep.txt": "deep" },
  });
  server.publish(channel, v1);
  expect((await app.download(server.url(channel))).status).toBe("staged");
  expect(server.blobRequests().length).toBe(Object.keys(v1.files).length);
  await app.expectBuiltin();

  await app.restart();
  await app.expectBundle("v1");
  await expect.poll(async () => (await app.state()).pendingReady).toBe(false);
  expect(app.bundles()).toEqual(["v1"]);

  // sub-resources, encoded names and SPA fallback through the tauri:// protocol
  const fetchText = (u: string) =>
    app.session!.executeAsync<string>(
      `const done = arguments[arguments.length - 1]; fetch(arguments[0]).then((r) => r.text()).then(done, (e) => done("ERR " + e));`,
      [u],
    );
  expect(await fetchText("/dir%20with%20space/%C3%BC%20%C3%B1.txt")).toBe(
    "unicode",
  );
  expect(await fetchText("/a/b/c/deep.txt")).toBe("deep");
  await app.session!.execute(
    `location.href = "/some/client/route"; return null;`,
  );
  await app.expectBundle("v1");

  await delay(READY_TIMEOUT + 1_000);
  await app.restart();
  await app.expectBundle("v1");
});

test("files are reused from the embedded built-in bundle", async ({
  app,
  server,
  channel,
}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "content-update-app-"));
  fs.cpSync(BUILTIN_DIR, dir, { recursive: true });
  const manifest = createBundle(dir, {
    outDir: server.blobs,
    version: "app-copy",
  });
  fs.rmSync(dir, { recursive: true });
  server.publish(channel, manifest);

  expect((await app.download(server.url(channel))).status).toBe("staged");
  expect(server.blobRequests()).toEqual([]);
  await app.invokeNoWait("apply");
  await app.expectBuiltin();
  expect((await app.state()).currentVersion).toBe("app-copy");
  // the app's own sync() confirms it
  await expect.poll(async () => (await app.state()).pendingReady).toBe(false);
});

test("a bundle that never calls notifyReady is rolled back, live and after a crash", async ({
  app,
  server,
  channel,
}) => {
  server.publish(channel, makeBundle(server, "bad", { ready: false }));
  await app.download(server.url(channel));
  await app.invokeNoWait("apply");
  await app.expectBundle("bad");
  // live: the ready timer reloads the built-in bundle
  await app.expectBuiltin(READY_TIMEOUT + 10_000);
  expect(await app.state()).toMatchObject({
    isBuiltin: true,
    failedVersions: ["bad"],
  });

  // crash: a forced retry that dies before notifyReady is rolled back on the next launch
  await app.download(server.url(channel), { force: true });
  await app.restart();
  await app.expectBundle("bad");
  expect(app.persisted()).toMatchObject({ current: "bad", trial: true });
  await app.kill();
  await app.start();
  await app.expectBuiltin();
  expect(app.persisted()).toMatchObject({
    current: null,
    trial: false,
    failed: ["bad"],
  });
});

test("reset() goes back to the built-in bundle", async ({
  app,
  server,
  channel,
}) => {
  server.publish(channel, makeBundle(server, "v1"));
  await app.download(server.url(channel));
  await app.invokeNoWait("apply");
  await app.expectBundle("v1");
  await app.invokeNoWait("reset");
  await app.expectBuiltin();
  expect(await app.state()).toMatchObject({
    isBuiltin: true,
    nextVersion: null,
  });
  await expect.poll(() => app.bundles()).toEqual([]);
});

test("bundles the app can't run aren't installed, and the app asks for an update", async ({
  app,
  server,
  channel,
}) => {
  const { nativeVersionCode } = await app.state();
  // the desktop app's native API: resolved for the linux target
  for (const [version, options, reason] of [
    ["future", { minNativeVersion: nativeVersionCode + 1 }, "nativeVersion"],
    [
      "denied",
      { files: { "a.js": `invoke("plugin:window|close")` } },
      "nativeApi",
    ],
    [
      "resigned",
      { files: { "a.js": appCommand("app_info", "0123456789ab") } },
      "nativeApi",
    ],
  ] as const) {
    server.publish(channel, makeBundle(server, version, options));
    expect(await app.download(server.url(channel))).toMatchObject({
      status: "incompatible",
      reason,
    });
  }
  expect(server.blobRequests()).toEqual([]);
  expect((await app.state()).incompatibleVersion).toBe("resigned");

  await app.restart();
  await waitFor(async () => (await app.page())?.modal, "the update modal");
  await app.expectBuiltin();

  // runnable again: the app command as it is, a command the capability allows
  server.publish(
    channel,
    makeBundle(server, "ok", {
      files: { "a.js": `${appCommand("app_info")} plugin:app|version` },
    }),
  );
  expect((await app.download(server.url(channel))).status).toBe("staged");
  expect((await app.state()).incompatibleVersion).toBeNull();
  await app.restart();
  await app.expectBundle("ok");
});

test("installed bundles are checked against the binary at boot, before they're served", async ({
  app,
  server,
  channel,
}) => {
  server.publish(channel, makeBundle(server, "v1"));
  await app.download(server.url(channel));
  await app.invokeNoWait("apply");
  await app.expectBundle("v1");
  await expect.poll(async () => (await app.state()).pendingReady).toBe(false);
  server.publish(channel, makeBundle(server, "v2"));
  expect((await app.download(server.url(channel))).status).toBe("staged");
  await app.stop();

  // a binary that changed without being detected as a new one (the binary identity is path + size
  // + mtime) and lacks native API the installed bundles use
  const needMore = (version: string) => {
    const file = path.join(
      app.dataDir,
      "bundles",
      version,
      "content-update.json",
    );
    const m = JSON.parse(fs.readFileSync(file, "utf-8"));
    m.requires = [...(m.requires ?? []), "0123456789ab"];
    fs.writeFileSync(file, JSON.stringify(m));
  };

  // the staged bundle isn't activated
  needMore("v2");
  await app.start();
  await app.expectBundle("v1");
  expect(await app.state()).toMatchObject({
    currentVersion: "v1",
    nextVersion: null,
    incompatibleVersion: "v2",
  });
  await app.stop();

  // nor the running one: back to the built-in bundle
  needMore("v1");
  await app.start();
  await app.expectBuiltin();
  expect(await app.state()).toMatchObject({
    isBuiltin: true,
    pendingReady: false,
    incompatibleVersion: "v1",
    // not broken, just not for this binary
    failedVersions: [],
  });
  await waitFor(async () => (await app.page())?.modal, "the update modal");
  await expect.poll(() => app.bundles()).toEqual([]);
});

test("a new binary drops downloaded bundles and the update request", async ({
  app,
  server,
  channel,
}) => {
  server.publish(channel, makeBundle(server, "v1"));
  await app.download(server.url(channel));
  await app.invokeNoWait("apply");
  await app.expectBundle("v1");
  await expect.poll(async () => (await app.state()).pendingReady).toBe(false);
  // the old binary learned that it needs an update
  server.publish(
    channel,
    makeBundle(server, "v2", { nativeApi: ["plugin:fs|read_file"] }),
  );
  expect((await app.download(server.url(channel))).status).toBe("incompatible");
  await app.stop();

  // an updated binary: same path, new mtime (the binary identity is path + size + mtime)
  const { atime, mtime } = fs.statSync(DESKTOP_BIN);
  fs.utimesSync(DESKTOP_BIN, atime, new Date(mtime.getTime() + 1_000));
  try {
    await app.start();
    await app.expectBuiltin();
    expect(await app.state()).toMatchObject({
      isBuiltin: true,
      failedVersions: [],
      incompatibleVersion: null,
    });
    expect(app.bundles()).toEqual([]);
  } finally {
    fs.utimesSync(DESKTOP_BIN, atime, mtime);
  }
});
