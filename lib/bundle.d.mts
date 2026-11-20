export declare const META: "content-update.json";

export interface ManifestFile {
  sha256: string;
  size: number;
}

export interface Manifest {
  version: string;
  /** the bundle is skipped by apps whose native version code is lower (android versionCode) */
  minNativeVersion?: number;
  /** hashes of the native API the bundle uses, apps that don't provide all of it skip the bundle */
  requires?: string[];
  /** relative path (`/`-separated) -> content */
  files: Record<string, ManifestFile>;
}

export interface BundleOptions {
  /** defaults to a hash of the file list */
  version?: string;
  minNativeVersion?: number;
  /**
   * native API ids the bundle uses besides the ones found in its code, e.g. commands invoked with
   * computed names: `plugin:<plugin>|<command>`
   */
  nativeApi?: string[];
}

export declare const HASH_LEN: 12;

/** the hash of a native API id (`plugin:<plugin>|<command>` or an app command signature) */
export declare function nativeApiHash(id: string): string;

/** hash -> id of the native API a web build's code uses */
export declare function findNativeApi(srcDir: string): Map<string, string>;

export declare function createManifest(
  srcDir: string,
  options?: BundleOptions,
): Manifest;

export declare function createBundle(
  srcDir: string,
  options?: BundleOptions & { outDir?: string },
): Manifest;
