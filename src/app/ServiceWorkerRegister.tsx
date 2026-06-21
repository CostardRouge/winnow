"use client";

import { useEffect } from "react";

// Registers the service worker (public/sw.js) once the page has loaded. Kept in
// its own client component so the root layout can stay a server component.
// Registration is skipped in development to avoid stale-cache surprises while
// iterating; production builds get the full installable PWA behaviour.
export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
      return;
    }

    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch((err) => {
        console.error("Service worker registration failed:", err);
      });
    };

    if (document.readyState === "complete") {
      register();
    } else {
      window.addEventListener("load", register);
      return () => window.removeEventListener("load", register);
    }
  }, []);

  return null;
}
