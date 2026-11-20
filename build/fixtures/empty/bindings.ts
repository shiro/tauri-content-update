// Generated from the app's tauri commands by tauri-plugin-content-update (build.rs or `content-update bindings`), do not edit.
// The `native-api:<command>:<hash>` ids tell `content-update bundle` which native API a web bundle uses.
import { invoke } from "@tauri-apps/api/core";

function call<T>(id: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(id.split(":")[1], args);
}
