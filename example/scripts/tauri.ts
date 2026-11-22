// `pnpm tauri <args>`: the tauri cli with a fixed-up environment (scripts/env.ts)
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fixEnv } from "./env.ts";

fixEnv();
const child = spawn(
  path.resolve(import.meta.dirname, "../node_modules/.bin/tauri"),
  process.argv.slice(2),
  { stdio: "inherit" },
);
// Ctrl+C reaches the cli directly (same process group); just wait for it
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.on(signal, () => {});
child.once("exit", (code, signal) =>
  process.exit(
    code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1),
  ),
);
