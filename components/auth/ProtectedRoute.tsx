"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "./AuthProvider";
import { canAccessProtectedRoute } from "@/lib/auth/guard";

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const {
    loading,
    user,
    error,
    refreshAccess,
    sessionNeedsAttention,
  } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !canAccessProtectedRoute(user) && !error) router.replace("/login");
  }, [loading, user, error, router]);

  if (loading) {
    return (
      <main className="centered-state" aria-live="polite">
        <span className="spinner" aria-hidden="true" />
        <p>Loading your attendance workspace…</p>
      </main>
    );
  }

  if (!canAccessProtectedRoute(user)) {
    return (
      <main className="centered-state">
        {error ? (
          <>
            <h1>We couldn’t open the app</h1>
            <p>{error}</p>
            {sessionNeedsAttention && (
              <button
                className="button primary"
                type="button"
                onClick={() => void refreshAccess()}
              >
                Repair sign-in
              </button>
            )}
            <a className="button secondary" href="/login">
              Return to login
            </a>
          </>
        ) : (
          <p>Taking you to login…</p>
        )}
      </main>
    );
  }

  return children;
}
