// Generated from the app's tauri commands by tauri-plugin-content-update (build.rs or `content-update bindings`), do not edit.
// The `native-api:<command>:<hash>` ids tell `content-update bundle` which native API a web bundle uses.
import { Channel, invoke } from "@tauri-apps/api/core";

function call<T>(id: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(id.split(":")[1], args);
}

export type A = {
  b: B | null;
};

export type B = {
  a: A[];
};

export type Everything<T> = {
  s: string;
  r: string;
  c: string;
  path: string;
  os: string;
  b: boolean;
  ints: [number, number, number, number, number, number];
  sints: [number, number, number, number, number, number];
  floats: [number, number];
  value: unknown;
  opt: number | null | null;
  opt_list: (number | null)[];
  lists: [number[], number[], number[], number[], number[], number[]];
  maps: [Record<string, number>, Record<string, number[]>, Record<string, Local>];
  map_one_arg: unknown;
  smart: [number, string, string, string, number[]];
  slice: number[];
  mut_ref: number[];
  array: number[];
  array_expr: Local[];
  tuple1: [number];
  unit: null;
  paren: number;
  generic: T;
  generic_list: T[];
  crate_path: Local;
  self_path: Local;
  super_path: Local;
  foreign_path: unknown;
  nested_path: unknown;
  nested_local: Local2;
  duration: unknown;
  with_lifetime: unknown;
  turbofish: number[];
  leading: string;
  dyn_box: unknown;
  bare_trait: unknown;
  impl_trait: unknown;
  fn_ptr: unknown;
  unsafe_fn: unknown;
  hr_fn: unknown;
  hr_trait: unknown;
  ptr: unknown;
  never: unknown;
  infer: unknown[];
  qself: unknown;
  assoc: unknown;
  macro_type: unknown;
  option_bare: unknown;
  result: unknown;
  io_result: unknown;
  const_arg: unknown;
  bool_arg: unknown;
  block_arg: unknown;
  channel_field: Channel<number>;
  raw_type: Local;
  fn_trait: unknown;
  nested_generic: (Record<string, ([number, string | null])[]>)[];
};

export type Local = {
  a: number;
};

export type Local2 = {
  b: number;
};

export type Progress = {
  done: number;
  total: number | null;
};

export type Tree = {
  children: Tree[];
  parent: Tree | null;
};

export function channelArg(onProgress: Channel<Progress>, onRaw: Channel<number[]>): Promise<void> {
  return call<void>("native-api:channel_arg:85735f24edc6", { onProgress, onRaw });
}

export function everything(allTypes: Everything<Local>, tree: Tree, aRef: A, type: string, default_: number, function_: boolean, plainName: number): Promise<([number, string] | null)[]> {
  return call<([number, string] | null)[]>("native-api:everything:5ded5aaeafd2", { all_types: allTypes, tree, a_ref: aRef, type, default: default_, function: function_, plain_name: plainName });
}

export function genericFn(value: number): Promise<number> {
  return call<number>("native-api:generic_fn:c09708d7daaa", { value });
}

export function resultArg(r: unknown, tupleArg: [number, string], listOfOptions: (string | null)[]): Promise<void> {
  return call<void>("native-api:result_arg:301f51585afb", { r, tupleArg, listOfOptions });
}

export function returnsBox(): Promise<number> {
  return call<number>("native-api:returns_box:0c968d68d29f");
}

export function returnsImpl(): Promise<unknown> {
  return call<unknown>("native-api:returns_impl:510ba81da47e");
}

export function returnsIoResult(): Promise<string> {
  return call<string>("native-api:returns_io_result:a453334818f1");
}

export function returnsList(): Promise<string[]> {
  return call<string[]>("native-api:returns_list:b11cf3e0e24d");
}

export function returnsOpaque(): Promise<unknown> {
  return call<unknown>("native-api:returns_opaque:6c22d2c38fa1");
}

export function returnsRef(x: string): Promise<string> {
  return call<string>("native-api:returns_ref:e29e1765588a", { x });
}

export function returnsResultUnit(): Promise<void> {
  return call<void>("native-api:returns_result_unit:c5af41fadbb8");
}

export function returnsUnit(): Promise<void> {
  return call<void>("native-api:returns_unit:ae15f398e09c");
}

export function returnsValue(): Promise<unknown> {
  return call<unknown>("native-api:returns_value:f267af52d444");
}
