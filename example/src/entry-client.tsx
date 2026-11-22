// @refresh reload
import { mount, StartClient } from "@solidjs/start/client";
import { isTauri } from "@tauri-apps/api/core";
import { routeServerFunctions } from "~/backend";
import { startContentUpdate } from "~/contentUpdate";
import { hideSplash } from "~/splash";

routeServerFunctions();
mount(() => <StartClient />, document.getElementById("app")!);

if (isTauri()) void startContentUpdate();
else hideSplash();
