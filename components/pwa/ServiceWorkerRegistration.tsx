"use client";

import { useEffect } from "react";

export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    let registration: ServiceWorkerRegistration | undefined;
    let refreshing = false;
    const reloadKey = "alupc-service-worker-v7-reloaded";
    const handleControllerChange = () => {
      if (refreshing) return;
      refreshing = true;
      if (window.sessionStorage.getItem(reloadKey) !== "true") {
        window.sessionStorage.setItem(reloadKey, "true");
        window.location.reload();
      }
    };
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
        registered.waiting?.postMessage({ type: "SKIP_WAITING" });
        registered.addEventListener("updatefound", () => {
          const installing = registered.installing;
          installing?.addEventListener("statechange", () => {
            if (installing.state === "installed" && navigator.serviceWorker.controller) {
              installing.postMessage({ type: "SKIP_WAITING" });
            }
          });
        });
        checkForUpdate();
      });

    navigator.serviceWorker.addEventListener(
      "controllerchange",
      handleControllerChange,
    );
    window.addEventListener("online", checkForUpdate);
    window.addEventListener("focus", checkForUpdate);
    const interval = window.setInterval(checkForUpdate, 60 * 60 * 1000);

    return () => {
      navigator.serviceWorker.removeEventListener(
        "controllerchange",
        handleControllerChange,
      );
      window.removeEventListener("online", checkForUpdate);
      window.removeEventListener("focus", checkForUpdate);
      window.clearInterval(interval);
    };
  }, []);
  return null;
}
