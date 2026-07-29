"use client";

const DATA_CHANGED_EVENT = "church-attendance:data-changed";

export function announceDataChanged() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(DATA_CHANGED_EVENT));
  }
}

export function subscribeToDataChanges(listener: () => void) {
  window.addEventListener(DATA_CHANGED_EVENT, listener);
  return () => window.removeEventListener(DATA_CHANGED_EVENT, listener);
}
