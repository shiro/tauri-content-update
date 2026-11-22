import { expect, test } from "@playwright/test";

test("chrome test", async ({ page }, testInfo) => {
  await page.goto(testInfo.project.use.baseURL!);
  await expect(page).toHaveTitle(/Test/);
  await expect(page.getByText(/hello\s*world/)).toBeVisible();
  // outside of tauri: no native info, no content updates
  await expect(page.getByText(/^native /)).toHaveCount(0);
  await expect(page.getByRole("dialog")).toBeHidden();
});
