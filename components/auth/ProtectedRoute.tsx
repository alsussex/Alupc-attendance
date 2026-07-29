"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "./AuthProvider";
import { canAccessProtectedRoute } from "@/lib/auth/guard";

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const {
    loading,
    session,
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
            <h1>
              {sessionNeedsAttention
                ? "Sign-in needs attention"
                : session
                  ? "Church data is temporarily unavailable"
                  : "We couldn’t open the app"}
            </h1>
            <p>{error}</p>
            {session && !sessionNeedsAttention && (
              <button
                className="button primary"
                type="button"
                onClick={() => void refreshAccess()}
              >
                Retry church access
              </button>
            )}
            <a className="button secondary" href="/login">
              {sessionNeedsAttention ? "Sign in again" : "Return to login"}
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
