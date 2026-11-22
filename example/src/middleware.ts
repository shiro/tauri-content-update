import { createMiddleware } from "@solidjs/start/middleware";

// The production app's pages are served by the app itself, so its server function calls are
// cross-origin requests to the backend (see src/backend.ts). Allow the app origins: answer CORS
// preflights, add the CORS headers, and let their requests pass the cross-site check of server
// functions (no cookies are used, so this doesn't expose any session to other origins).
const APP_ORIGINS = new Set([
  // Android (and Windows) WebView
  "http://tauri.localhost",
  "https://tauri.localhost",
  // Linux and macOS
  "tauri://localhost",
]);

// response headers the server function client reads (@solidjs/start fns/client.js, fns/shared.js)
const EXPOSED_HEADERS = [
  "X-Start-Type",
  "X-Start-Skew",
  "X-Error",
  "X-Revalidate",
  "X-Single-Flight",
  "Location",
].join(", ");

export default createMiddleware({
  onRequest: (event) => {
    const origin = event.request.headers.get("origin");
    if (!origin || !APP_ORIGINS.has(origin)) return;

    if (event.request.method == "OPTIONS")
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "GET, POST",
          "Access-Control-Allow-Headers":
            event.request.headers.get("access-control-request-headers") ?? "",
          "Access-Control-Max-Age": "600",
          Vary: "Origin",
        },
      });

    // h3 sends `headers` with successful responses and `errHeaders` with errors
    const { res } = event.nativeEvent;
    for (const headers of [res.headers, res.errHeaders]) {
      headers.set("Access-Control-Allow-Origin", origin);
      headers.set("Access-Control-Expose-Headers", EXPOSED_HEADERS);
      headers.append("Vary", "Origin");
    }

    // the WebView sends `Sec-Fetch-Site: cross-site`, which server functions reject (changed in
    // place: the server's request isn't a native Request that `new Request(request)` could copy)
    event.request.headers.set("sec-fetch-site", "same-site");
  },
});
