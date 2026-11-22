// Environment fix-ups for the android/tauri tooling, so it works no matter what the user's shell
// exports on top of shell.nix (e.g. an rc file setting JAVA_HOME to a JDK that doesn't exist on NixOS).
import fs from "node:fs";
import path from "node:path";

const which = (bin: string) =>
  (process.env.PATH ?? "")
    .split(path.delimiter)
    .map((dir) => path.join(dir, bin))
    .find((p) => {
      try {
        fs.accessSync(p, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });

/** JAVA_HOME if it contains a java, otherwise the JDK of the `java` on PATH (shell.nix's JDK 21) */
function javaHome(): string | undefined {
  const current = process.env.JAVA_HOME;
  if (current && fs.existsSync(path.join(current, "bin/java"))) return current;
  const java = which("java");
  return java && path.dirname(path.dirname(fs.realpathSync(java)));
}

export function fixEnv() {
  const java = javaHome();
  if (java) process.env.JAVA_HOME = java;
  else delete process.env.JAVA_HOME;
  // the @tauri-apps/cli native binary links liblzma (shell.nix)
  const lib = process.env.TAURI_CLI_LIBRARY_PATH;
  const ld = process.env.LD_LIBRARY_PATH?.split(":") ?? [];
  if (lib && !ld.includes(lib))
    process.env.LD_LIBRARY_PATH = [lib, ...ld].join(":");
}
