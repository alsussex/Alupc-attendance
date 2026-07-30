"use client";

import { useLayoutEffect } from "react";
import { passwordRecoveryDestination } from "@/lib/auth/callback-routing";

export function AuthCallbackRouter() {
  useLayoutEffect(() => {
    const destination = passwordRecoveryDestination(window.location.href);
    if (destination) {
      window.location.replace(destination);
    }
  }, []);

  return null;
}
