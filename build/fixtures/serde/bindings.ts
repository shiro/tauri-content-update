// Generated from the app's tauri commands by tauri-plugin-content-update (build.rs or `content-update bindings`), do not edit.
// The `native-api:<command>:<hash>` ids tell `content-update bundle` which native API a web bundle uses.
import { invoke } from "@tauri-apps/api/core";

function call<T>(id: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(id.split(":")[1], args);
}

export type Adjacent =
  | { t: "Unit" }
  | { t: "Newtype"; c: number }
  | { t: "Tuple"; c: [number, number] }
  | { t: "Struct"; c: { a: number } };

export type Empty = {
};

/** Externally tagged. */
export type External =
  | "Unit"
  | { Newtype: number }
  | { Tuple: [number, string] }
  | { Struct: { some_field: number; "x-y": boolean } }
  | "renamed"
  | { StructRenamed: { someField: number } }
  | "WithDiscriminant";

export type Extra = {
  a: number;
};

export type Internal =
  | { kind: "unit_variant" }
  | ({ kind: "newtype" } & Extra)
  | { kind: "struct"; a: number };

export type Kebab = {
  "some-field": number;
};

export type Lower = {
  some_field: number;
};

export type Never =
  | never;

export type Newtype = number[];

export type OnlySkipped =
  | never;

export type Pair = [number, string];

export type Pascal = {
  SomeField: number;
  Type: number;
};

export type QuotedTag =
  | { "my-tag": "Variant" };

/**
 * Field renames.
 *
 * Second paragraph with a *\/ in it.
 */
export type Renamed = {
  FIRST_FIELD: number;
  "explicit-name": number;
  ser_name: number;
  FOURTH_FIELD: number;
  WITH_DEFAULT?: number[];
  WITH_DEFAULT_FN?: number;
  listed?: string[];
  BOUNDED: boolean;
  "with \"quotes\" and \\": boolean;
  "raw \"name\"": boolean;
  /**
   * multi
   * line
   *
   * doc
   */
  DOCUMENTED: boolean;
  /**
   * explicit doc
   * with "escapes"
   */
  EXPLICIT_DOC: boolean;
  /** block doc  */
  BLOCK_DOC: boolean;
  AFTER_ERROR: boolean;
  second: boolean;
  BAD_RENAME: boolean;
} & Extra & Record<string, unknown>;

export type Screaming =
  | "HTTP_SERVER"
  | "A"
  | "A_B_C"
  | "UNICODE_ÉTÉ";

export type ScreamingKebab = {
  "SOME-FIELD": number;
};

export type SerOnly = {
  someField: number;
};

export type Snake = {
  some_field: number;
};

export type Transparent = string[];

export type TransparentEmpty = null;

export type Unit = null;

export type Unknown = {
  some_field: number;
};

export type Untagged =
  | null
  | number
  | [number, number]
  | { a: number };

export type Upper = {
  SOME_FIELD: number;
};

export function serdeEnums(external: External, internal: Internal, adjacent: Adjacent, untagged: Untagged, quotedTag: QuotedTag, screaming: Screaming, never: Never, onlySkipped: OnlySkipped): Promise<void> {
  return call<void>("native-api:serde_enums:6f65bcc42c4e", { external, internal, adjacent, untagged, quotedTag, screaming, never, onlySkipped });
}

export function serdeTypes(renamed: Renamed, pascal: Pascal, kebab: Kebab, screamingKebab: ScreamingKebab, lower: Lower, upper: Upper, snake: Snake, unknown: Unknown, serOnly: SerOnly, transparent: Transparent, transparentEmpty: TransparentEmpty, newtype: Newtype, pair: Pair, unit: Unit, empty: Empty): Promise<void> {
  return call<void>("native-api:serde_types:dce8c77900b9", { renamed, pascal, kebab, screamingKebab, lower, upper, snake, unknown, serOnly, transparent, transparentEmpty, newtype, pair, unit, empty });
}
