"use client";

import { useEffect, useRef } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { clearUndoHistory } from "@/lib/undo/undo-service";

export function UndoHistorySession() {
  const { user } = useAuth();
  const sessionKey = user
    ? `${user.organizationId}:${user.userId}`
    : "signed-out";
  const previousSession = useRef(sessionKey);

  useEffect(() => {
    if (previousSession.current !== sessionKey) {
      clearUndoHistory();
      previousSession.current = sessionKey;
    }
  }, [sessionKey]);

  return null;
}
