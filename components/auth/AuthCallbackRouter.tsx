"use client";

import { useLayoutEffect } from "react";
import { authCallbackDestination } from "@/lib/auth/callback-routing";

export function AuthCallbackRouter() {
  useLayoutEffect(() => {
    const destination = authCallbackDestination(window.location.href);
    if (destination) {
      window.location.replace(destination);
    }
  }, []);

  return null;
}
