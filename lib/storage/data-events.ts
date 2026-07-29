"use client";

const DATA_CHANGED_EVENT = "church-attendance:data-changed";
const MUTATION_QUEUED_EVENT = "church-attendance:mutation-queued";

export function announceDataChanged() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(DATA_CHANGED_EVENT));
  }
}

export function subscribeToDataChanges(listener: () => void) {
  window.addEventListener(DATA_CHANGED_EVENT, listener);
  return () => window.removeEventListener(DATA_CHANGED_EVENT, listener);
}

export function announceMutationQueued() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(MUTATION_QUEUED_EVENT));
  }
}

export function subscribeToQueuedMutations(listener: () => void) {
  window.addEventListener(MUTATION_QUEUED_EVENT, listener);
  return () => window.removeEventListener(MUTATION_QUEUED_EVENT, listener);
}
