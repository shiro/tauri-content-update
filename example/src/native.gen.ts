// Generated from the app's tauri commands by tauri-plugin-content-update (build.rs or `content-update bindings`), do not edit.
// The `native-api:<command>:<hash>` ids tell `content-update bundle` which native API a web bundle uses.
import { invoke } from "@tauri-apps/api/core";

function call<T>(id: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(id.split(":")[1], args);
}

/** What the native side of the app reports about itself. */
export type AppInfo = {
  /** the app version (`version` in tauri.conf.json) */
  version: string;
  /** `android`, `linux`, `macos`, `windows`, `ios` */
  platform: string;
};

/** The app's version and platform. */
export function appInfo(): Promise<AppInfo> {
  return call<AppInfo>("native-api:app_info:419cc273665f");
}
