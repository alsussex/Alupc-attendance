"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/auth/AuthProvider";
import { isAdmin } from "@/lib/auth/permissions";

export function AdminOnly({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (user && !isAdmin(user)) router.replace("/dashboard");
  }, [router, user]);

  if (!isAdmin(user)) {
    return (
      <section className="empty-panel" role="alert">
        <h1>Administrator access required</h1>
        <p>This area is available only to an Abundant Life UPC administrator.</p>
      </section>
    );
  }
  return children;
}
