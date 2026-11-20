import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** rejections of the plugin's commands, `code` is e.g. `DOWNLOAD_FAILED` */
export class ContentUpdateError extends Error {
  constructor({ code, message }) {
    super(message);
    this.name = "ContentUpdateError";
    this.code = code;
  }
}

// the full command names are literals so `content-update bundle` sees which commands a bundle uses
const call = (command, args) =>
  invoke(command, args).catch((e) => {
    throw e && typeof e == "object" && "code" in e
      ? new ContentUpdateError(e)
      : e;
  });

export const ContentUpdate = {
  getState: () => call("plugin:content-update|get_state"),
  notifyReady: () => call("plugin:content-update|notify_ready"),
  check: (options = {}) => call("plugin:content-update|check", options),
  download: (options = {}) => call("plugin:content-update|download", options),
  apply: () => call("plugin:content-update|apply"),
  reset: () => call("plugin:content-update|reset"),
  onDownloadProgress: (listener) =>
    listen("content-update://download-progress", (e) => listener(e.payload)),
  onRollback: (listener) =>
    listen("content-update://rollback", (e) => listener(e.payload)),
};

/**
 * The app's startup call: marks the running bundle as working, checks the published version
 * (whether this app can run it: `minNativeVersion` and the native API it uses) and downloads and
 * stages it. `updateRequired` is the answer to "does the user have to update the app?", also
 * offline: it's remembered from earlier checks and from the boot check of the installed bundles.
 * Never throws: failures are returned as `{ status: "error", error }`.
 */
export async function sync({ url, apply = "next-launch" } = {}) {
  if (!isTauri()) return { status: "unsupported", updateRequired: false };
  let result;
  try {
    await ContentUpdate.notifyReady();
    if (!url && !(await ContentUpdate.getState()).manifestUrl)
      result = { status: "disabled" };
    else {
      result = await ContentUpdate.download(url ? { url } : {});
      if (result.status == "staged" && apply == "now")
        await ContentUpdate.apply();
    }
  } catch (error) {
    result = { status: "error", error };
  }
  const state = await ContentUpdate.getState().catch(() => undefined);
  return { ...result, updateRequired: !!state?.incompatibleVersion };
}
