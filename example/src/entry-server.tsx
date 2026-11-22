// @refresh reload
import { createHandler, StartServer } from "@solidjs/start/server";
import iconSvg from "../src-tauri/icons/icon.svg?raw";

const icon = iconSvg.replace(/ id="[^"]*"/g, "");

export default createHandler(() => (
  <StartServer
    document={({ assets, children, scripts }) => (
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <link rel="icon" href="/favicon.ico" />
          <style innerHTML={splashCss} />
          {assets}
        </head>
        <body>
          <div id="app">{children}</div>
          <div id="splash">
            <div innerHTML={icon} />
            <div id="splash-fill" innerHTML={icon} />
          </div>
          <script innerHTML="requestAnimationFrame(() => requestAnimationFrame(() => window.NativeSplash?.shown()))" />
          {scripts}
        </body>
      </html>
    )}
  />
));

// same size and position as the android splash icon (res/drawable/splash_icon.xml: 72 units of
// 108 in 288dp, scaled 0.9)
const splashCss = `
#splash {
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  background: #24273a;
  transition: opacity 200ms;
}
#splash > div {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 172.8px;
  height: 172.8px;
  margin: -86.4px 0 0 -86.4px;
  opacity: 0.5;
}
#splash svg {
  display: block;
  width: 100%;
  height: 100%;
}
#splash > #splash-fill {
  opacity: 1;
  clip-path: inset(calc((1 - var(--progress, 0)) * 100%) 0 0 0);
  transition: clip-path var(--duration, 1s) ease-in-out;
}
`;
