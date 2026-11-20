// Generated from the app's tauri commands by tauri-plugin-content-update (build.rs or `content-update bindings`), do not edit.
// The `native-api:<command>:<hash>` ids tell `content-update bundle` which native API a web bundle uses.
import { invoke } from "@tauri-apps/api/core";

function call<T>(id: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(id.split(":")[1], args);
}

/** 
 * Block doc,
 * multi-line.
  */
export type BlockDoc = {
  a: number;
};

export type Comments = {
  /**
   * line doc with trailing spaces  
   *
   *    indented
   */
  a: number;
};

/** doc with unicode: éè ☃ and an emoji 😀 */
export type Unicode = {
  "café": number;
  "étA\n\t": number;
  "line continued": number;
};

export function lexer(a: BlockDoc, b: Comments, c: Unicode): Promise<number> {
  return call<number>("native-api:lexer:ae9dedf3bb33", { a, b, c });
}
