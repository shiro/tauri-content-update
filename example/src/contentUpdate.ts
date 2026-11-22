import { ContentUpdate, sync } from "tauri-plugin-content-update";
import { createSignal } from "solid-js";
import { finishSplash, setSplashProgress } from "~/splash";

const [updateRequired, setUpdateRequired] = createSignal(false);

/**
 * The published web version can't run on this app (it needs a newer native version or native API
 * this app doesn't have): the app has to be updated from the store. Remembered by the plugin, so
 * it's also known offline.
 */
export { updateRequired };

/** runs once on startup, in tauri, behind the splash */
export async function startContentUpdate() {
  try {
    const unlisten = await ContentUpdate.onDownloadProgress((p) => {
      if (p.total > 0) setSplashProgress(p.loaded / p.total);
    }).catch(() => undefined);
    // confirms this bundle works (or it gets rolled back), checks whether this app can run the
    // published version, and downloads it and reloads into it
    const result = await sync({ apply: "now" });
    unlisten?.();
    console.log("content update:", result.status);
    setUpdateRequired(result.updateRequired);
  } finally {
    await finishSplash();
  }
}
