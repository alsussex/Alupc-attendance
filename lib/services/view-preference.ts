"use client";

export type ServicesView = "list" | "calendar";

const storageKey = "church-attendance:services-view";
const preferenceEvent = "church-attendance:services-view-changed";

export function getPreferredServicesView(): ServicesView {
  if (typeof window === "undefined") return "list";
  try {
    return window.localStorage.getItem(storageKey) === "calendar"
      ? "calendar"
      : "list";
  } catch {
    return "list";
  }
}

export function getServerServicesView(): ServicesView {
  return "list";
}

export function subscribeToServicesView(listener: () => void) {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener("storage", listener);
  window.addEventListener(preferenceEvent, listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener(preferenceEvent, listener);
  };
}

export function setPreferredServicesView(view: ServicesView) {
  try {
    window.localStorage.setItem(storageKey, view);
  } catch {
    // The view still changes for this render when storage is unavailable.
  }
  window.dispatchEvent(new CustomEvent(preferenceEvent));
}
