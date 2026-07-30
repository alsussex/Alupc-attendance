"use client";

import { useLayoutEffect } from "react";
import { LoadingSkeleton } from "@/components/feedback/LoadingSkeleton";

export default function LegacyAcceptInvitePage() {
  useLayoutEffect(() => {
    window.location.replace(
      `/auth/setup-password${window.location.search}${window.location.hash}`,
    );
  }, []);

  return (
    <main className="centered-state workspace-loading">
      <LoadingSkeleton label="Opening account setup" rows={3} />
    </main>
  );
}
