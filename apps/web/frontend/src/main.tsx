/**
 * Browser entry point: mount the app and (in a production build) register the PWA service worker.
 *
 * The service worker is skipped in `npm run dev` on purpose — a cache-first worker fighting Vite's
 * HMR is a classic own-goal. `npm run preview` (or the FastAPI server serving dist/) registers it.
 */

import { render } from "preact";

import { App } from "./app";
import "./styles.css";

const container = document.getElementById("app");
if (container === null) {
  throw new Error("index.html is missing the #app container");
}

render(<App />, container);

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((error: unknown) => {
      // A failed registration must never break the app; the page simply stays network-only.
      console.warn("scanlist: service worker registration failed", error);
    });
  });
}
