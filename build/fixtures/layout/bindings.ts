// Generated from the app's tauri commands by tauri-plugin-content-update (build.rs or `content-update bindings`), do not edit.
// The `native-api:<command>:<hash>` ids tell `content-update bundle` which native API a web bundle uses.
import { invoke } from "@tauri-apps/api/core";

function call<T>(id: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(id.split(":")[1], args);
}

export type InImpl = {
  a: number;
};

export type InTrait = [number, boolean];

export type Item = {
  id: number;
};

export type NestedInFn = {
  value: number;
};

export function fromDeep(item: Item): Promise<void> {
  return call<void>("native-api:from_deep:058eaa0fbefc", { item });
}

export function inConst(): Promise<number> {
  return call<number>("native-api:in_const:04a7ba9e9caf");
}

export function inImplBody(x: InImpl): Promise<void> {
  return call<void>("native-api:in_impl_body:9877f16d70ac", { x });
}

export function inTraitDefault(): Promise<InTrait[]> {
  return call<InTrait[]>("native-api:in_trait_default:bd359ab3390a");
}

/** listed twice in generate_handler! (by two paths): one command */
export function listed(item: Item): Promise<Item | null> {
  return call<Item | null>("native-api:listed:5252da45dd6b", { item });
}

export function nestedInFn(): Promise<NestedInFn> {
  return call<NestedInFn>("native-api:nested_in_fn:cd0c3470e170");
}

export function rawCommand(struct: number): Promise<void> {
  return call<void>("native-api:raw_command:7f1285e9ff80", { struct });
}
