"use client";

import { useEffect } from "react";

export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    let registration: ServiceWorkerRegistration | undefined;
    const checkForUpdate = () => {
      void registration?.update();
      navigator.serviceWorker.controller?.postMessage({
        type: "CHECK_FOR_UPDATE",
      });
    };

    void navigator.serviceWorker
      .register("/sw.js", { updateViaCache: "none" })
      .then((registered) => {
        registration = registered;
        checkForUpdate();
      });

    window.addEventListener("online", checkForUpdate);
    window.addEventListener("focus", checkForUpdate);
    const interval = window.setInterval(checkForUpdate, 60 * 60 * 1000);

    return () => {
      window.removeEventListener("online", checkForUpdate);
      window.removeEventListener("focus", checkForUpdate);
      window.clearInterval(interval);
    };
  }, []);
  return null;
}
