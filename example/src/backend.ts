// Server functions are RPC calls to `/_server` relative to the page. A web page is served by the
// backend itself, but a production app's pages are served by the app (`http://tauri.localhost` on
// Android, `tauri://localhost` on Linux), so their server function calls are sent to the backend at
// VITE_BACKEND_URL (set at build time, e.g. by `pnpm android:prod`). Unset (dev, the web build), the
// calls stay relative. The backend allows the app origins (src/middleware.ts).
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL?.replace(/\/+$/, "");

export function routeServerFunctions() {
  if (!BACKEND_URL) return;
  const fetch = window.fetch;
  window.fetch = async (input, init) => {
    // the server function client always calls fetch with a Request
    if (input instanceof Request) {
      const url = new URL(input.url);
      if (url.origin == location.origin && url.pathname.startsWith("/_server"))
        return fetch(
          new Request(BACKEND_URL + url.pathname + url.search, {
            method: input.method,
            headers: input.headers,
            // buffered: `new Request(url, input)` would pass it on as a stream, which Chromium only
            // uploads over HTTP/2 (ERR_H2_OR_QUIC_REQUIRED)
            body: input.body ? await input.arrayBuffer() : undefined,
            signal: input.signal,
          }),
          init,
        );
    }
    return fetch(input, init);
  };
}
