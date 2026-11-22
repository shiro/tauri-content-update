import { test as teardown } from "@playwright/test";
import fs from "node:fs";
import {
  AVD_NAME,
  EMULATOR_PORT,
  STATE_FILE,
  stopEmulator,
} from "./androidUtil";

// stops the emulator of android.setup.ts and deletes its AVD
// (ANDROID_E2E_KEEP_EMULATOR=1 keeps both for debugging; the next run recreates them anyway)
teardown("stop android emulator", async () => {
  if (!fs.existsSync(STATE_FILE)) return;
  fs.rmSync(STATE_FILE);
  if (process.env.ANDROID_E2E_KEEP_EMULATOR) return;
  await stopEmulator(AVD_NAME, EMULATOR_PORT);
});
