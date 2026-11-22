/** the loading splash of the document shell (entry-server.tsx), shown until the app is ready */

declare global {
  interface Window {
    /** android: the native splash (MainActivity.kt) that the web splash continues */
    NativeSplash?: { isShowing(): boolean };
  }
}

/** fills the icon up to `progress` (0..1) */
export function setSplashProgress(progress: number, durationMs = 300) {
  const fill = document.getElementById("splash-fill");
  if (!fill) return;
  // the style may not be computed yet (nothing rendered), then there's nothing to transition from
  void getComputedStyle(fill).clipPath;
  fill.style.setProperty("--duration", `${durationMs}ms`);
  fill.style.setProperty("--progress", `${progress}`);
}

/** fills the icon completely (taking 1s, once it's visible), then fades the splash out */
export async function finishSplash() {
  while (window.NativeSplash?.isShowing())
    await new Promise(requestAnimationFrame);
  setSplashProgress(1, 1000);
  await new Promise((r) => setTimeout(r, 1000));
  hideSplash();
}

export function hideSplash() {
  const splash = document.getElementById("splash");
  if (!splash) return;
  splash.style.opacity = "0";
  setTimeout(() => splash.remove(), 200);
}
