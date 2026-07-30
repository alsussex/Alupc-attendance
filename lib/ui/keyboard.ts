"use client";

import { useEffect, useRef } from "react";

export function useEscapeKey(onEscape: () => void, enabled = true) {
  const callback = useRef(onEscape);

  useEffect(() => {
    callback.current = onEscape;
  }, [onEscape]);

  useEffect(() => {
    if (!enabled) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      callback.current();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [enabled]);
}
