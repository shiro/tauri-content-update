/** prefix of the ids in the bindings: `native-api:<command>:<hash>` */
export declare const MARKER: "native-api";

export interface Command {
  /** the name it is invoked with */
  name: string;
  /** what its hash is made of: name, argument keys and wire shapes of the arguments and result */
  signature: string;
  /** `[js key, ts parameter name, ts type]` */
  args: [string, string, string][];
  /** the ts type the promise resolves to */
  ret: string;
  docs: string[];
}

export interface Api {
  /** the commands registered with `generate_handler!`, sorted by name */
  commands: Command[];
  /** ts declarations of the custom types the commands use, by name */
  types: Map<string, string>;
  usesChannel: boolean;
}

/** the commands registered with `generate_handler!` in the given Rust sources (file contents) */
export declare function analyze(sources: string[]): Api;
/** reads all `.rs` files below `srcDir` */
export declare function scan(srcDir: string): Api;
/** the TypeScript bindings file */
export declare function render(api: Api): string;
/**
 * Generates the bindings of the app crate in `crateDir` (its `src/**.rs`) to `out`, only writes the
 * file if it changed. Returns whether it changed.
 */
export declare function writeBindings(crateDir: string, out: string): boolean;
/** serde's `rename_all` rules, for field (snake_case) or variant (PascalCase) names */
export declare function rename(
  rule: string,
  name: string,
  variant: boolean,
): string;
