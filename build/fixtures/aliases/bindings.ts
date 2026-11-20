// Generated from the app's tauri commands by tauri-plugin-content-update (build.rs or `content-update bindings`), do not edit.
// The `native-api:<command>:<hash>` ids tell `content-update bundle` which native API a web bundle uses.
import { invoke } from "@tauri-apps/api/core";

function call<T>(id: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(id.split(":")[1], args);
}

export type Either<L, R> =
  | { Left: L }
  | { Right: R };

export type Page<T> = {
  items: T[];
  next: Page<T> | null;
};

export type Wrapper<T, U> = {
  t: T;
  u: U | null;
};

export function aliasBothParams(): Promise<number> {
  return call<number>("native-api:alias_both_params:04f0641f4b75");
}

export function aliasDefaultParam(): Promise<number> {
  return call<number>("native-api:alias_default_param:46ac58440d9b");
}

export function aliasNested(): Promise<number[] | null> {
  return call<number[] | null>("native-api:alias_nested:196940828fe2");
}

export function aliasResult(): Promise<Page<number>> {
  return call<Page<number>>("native-api:alias_result:8eb4124a9e48");
}

export function aliasSelfRef(s: unknown[]): Promise<unknown[][]> {
  return call<unknown[][]>("native-api:alias_self_ref:35f1576beeed", { s });
}

export function aliasTuple(p: [number, string]): Promise<[boolean, number[]]> {
  return call<[boolean, number[]]>("native-api:alias_tuple:c4caf44dd2d2", { p });
}

export function aliasWrapped(w: Page<Page<number>>): Promise<Page<Either<number, string>>> {
  return call<Page<Either<number, string>>>("native-api:alias_wrapped:5985c8906563", { w });
}

export function generics(w: Wrapper<number, string[]>, missing: Wrapper<number>, e: Either<Page<boolean>, null>): Promise<Either<number, Page<number>>> {
  return call<Either<number, Page<number>>>("native-api:generics:257b5c4ea445", { w, missing, e });
}
