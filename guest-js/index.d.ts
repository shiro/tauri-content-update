import type { UnlistenFn } from "@tauri-apps/api/event";

export type UpdateStatus =
  /** a different version is published and can be downloaded */
  | "available"
  /** the published version is the running one */
  | "up-to-date"
  /** the published version is downloaded and activates on the next launch (or `apply()`) */
  | "staged"
  /** the published version was rolled back before (pass `force` to download it anyway) */
  | "failed"
  /** the published version can't run on this app, which needs an update (see `reason`) */
  | "incompatible";

export type IncompatibleReason =
  /** the bundle's `minNativeVersion` is higher than the app's version code */
  | "nativeVersion"
  /** the bundle uses native API (commands, plugins, permissions) the app doesn't provide */
  | "nativeApi";

export interface UpdateInfo {
  status: UpdateStatus;
  /** the published version */
  version: string;
  /** the running version (`null` if the built-in bundle has no `content-update.json`) */
  currentVersion: string | null;
  minNativeVersion: number;
  /** status `incompatible` only */
  reason?: IncompatibleReason;
  /** bytes / files a download would fetch (status `available` only) */
  downloadSize?: number;
  downloadFiles?: number;
}

export interface ContentUpdateState {
  currentVersion: string | null;
  /** the app's embedded bundle is running */
  isBuiltin: boolean;
  builtinVersion: string | null;
  /** staged version, activated on the next launch */
  nextVersion: string | null;
  /** the running bundle must call `notifyReady()` or it gets rolled back */
  pendingReady: boolean;
  failedVersions: string[];
  /**
   * the last published version `check()`/`download()` saw that this app can't run (status
   * `incompatible`): the app should be updated. Cleared when a version it can run is published or
   * the app is updated.
   */
  incompatibleVersion: string | null;
  /** android versionCode (or the one derived from the app version) */
  nativeVersionCode: number;
  manifestUrl: string | null;
}

export interface DownloadProgress {
  version: string;
  loaded: number;
  total: number;
  files: number;
  totalFiles: number;
}

export interface UrlOptions {
  /** manifest url, defaults to `plugins > content-update > manifestUrl` in tauri.conf.json */
  url?: string;
}

export type ContentUpdateErrorCode =
  | "NO_URL"
  | "BUSY"
  | "NO_UPDATE"
  | "CHECK_FAILED"
  | "DOWNLOAD_FAILED"
  | "NOT_WRAPPED"
  | "IO";

export declare class ContentUpdateError extends Error {
  code: ContentUpdateErrorCode;
}

export declare const ContentUpdate: {
  getState(): Promise<ContentUpdateState>;
  /** call once the app is up; a new bundle that doesn't is rolled back after `readyTimeout` */
  notifyReady(): Promise<ContentUpdateState>;
  /** fetches the manifest, downloads nothing */
  check(options?: UrlOptions): Promise<UpdateInfo>;
  /** downloads (only the files not on the device yet) and stages the published version */
  download(options?: UrlOptions & { force?: boolean }): Promise<UpdateInfo>;
  /** activates the staged version now (reloads the webviews) */
  apply(): Promise<ContentUpdateState>;
  /** switches back to the built-in bundle now (reloads the webviews), forgets failed versions */
  reset(): Promise<ContentUpdateState>;
  onDownloadProgress(
    listener: (progress: DownloadProgress) => void,
  ): Promise<UnlistenFn>;
  onRollback(
    listener: (event: {
      failedVersion: string;
      version: string | null;
    }) => void,
  ): Promise<UnlistenFn>;
};

export type SyncResult = (
  | UpdateInfo
  | { status: "unsupported" | "disabled" }
  | { status: "error"; error: unknown }
) & {
  /**
   * the app has to be updated (from the store) to run the published web version: it's
   * `incompatible`, now or at an earlier check (`incompatibleVersion`, so also offline)
   */
  updateRequired: boolean;
};

/**
 * The app's startup call: `notifyReady()`, then checks the published version (can this app run
 * it?) and downloads + stages it. `apply: "now"` reloads into it right away instead of on the next
 * launch. Never throws.
 */
export declare function sync(
  options?: UrlOptions & { apply?: "next-launch" | "now" },
): Promise<SyncResult>;
