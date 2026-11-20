// Generated from the app's tauri commands by tauri-plugin-content-update (build.rs or `content-update bindings`), do not edit.
// The `native-api:<command>:<hash>` ids tell `content-update bundle` which native API a web bundle uses.
import { Channel, invoke } from "@tauri-apps/api/core";

function call<T>(id: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(id.split(":")[1], args);
}

export type Event =
  | { type: "Started"; at: number }
  | { type: "Stopped" };

/** What the app reports. */
export type Info = {
  /** the version */
  appVersion: string;
  size?: number | null;
  kind: Kind;
  pages: Page<string>;
};

export type Kind =
  | "desktop-app"
  | "mobile";

export type Page<T> = {
  items: T[];
};

export function events(onEvent: Channel<Event>): Promise<void> {
  return call<void>("native-api:events:cee890dcc3be", { onEvent });
}

/** Says hello. */
export function greet(type: string, userName: string | null): Promise<string> {
  return call<string>("native-api:greet:34c01117dfea", { type, userName });
}

export function info(): Promise<Info> {
  return call<Info>("native-api:info:6d68783d29c9");
}
