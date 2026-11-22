import { expect } from "@playwright/test";
import { androidTest } from "./androidTest";
import { APP_VERSION } from "./androidUtil";

androidTest("android test", async ({ page }, testInfo) => {
  await page.goto(testInfo.project.use.baseURL!);
  await expect(page).toHaveTitle(/Test/);
  await expect(page.getByText(/hello\s*world/)).toBeVisible();
  // an app command, called through the generated bindings (src/native.gen.ts)
  await expect(page.getByText(`native ${APP_VERSION} (android)`)).toBeVisible();
  // the tauri IPC works (the app called the content-update plugin on startup)
  expect(
    await page.evaluate(() =>
      (window as any).__TAURI_INTERNALS__.invoke(
        "plugin:content-update|get_state",
      ),
    ),
  ).toMatchObject({
    isBuiltin: true,
    pendingReady: false,
    incompatibleVersion: null,
  });
  await expect(page.getByRole("dialog")).toBeHidden();
});
