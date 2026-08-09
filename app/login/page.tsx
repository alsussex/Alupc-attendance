"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/auth/AuthProvider";
import {
  PASSWORD_RECOVERY_COOLDOWN_SECONDS,
  PasswordRecoveryRateLimitError,
  requestPasswordRecovery,
} from "@/lib/auth/password";
import { getSupabaseClient } from "@/lib/supabase/client";
import { useEscapeKey } from "@/lib/ui/keyboard";

const RECOVERY_COOLDOWN_STORAGE_KEY =
  "church-attendance-password-recovery-retry-at";

function storedRecoveryRetryAt() {
  if (typeof window === "undefined") return 0;
  const value = Number(
    window.localStorage.getItem(RECOVERY_COOLDOWN_STORAGE_KEY),
  );
  if (!Number.isFinite(value) || value <= Date.now()) {
    window.localStorage.removeItem(RECOVERY_COOLDOWN_STORAGE_KEY);
    return 0;
  }
  return value;
}

export default function LoginPage() {
  const { loading, user, error, signIn } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [recoveryEmail, setRecoveryEmail] = useState("");
  const [recoverySaving, setRecoverySaving] = useState(false);
  const [recoveryMessage, setRecoveryMessage] = useState("");
  const [recoveryError, setRecoveryError] = useState("");
  const [recoveryRetryAt, setRecoveryRetryAt] = useState(0);
  const [recoveryClock, setRecoveryClock] = useState(0);

  useEscapeKey(() => setRecoveryOpen(false), recoveryOpen);

  useEffect(() => {
    if (!loading && user) router.replace("/dashboard");
  }, [loading, user, router]);

  useEffect(() => {
    if (!recoveryOpen || recoveryRetryAt <= recoveryClock) return;
    const timer = window.setInterval(() => setRecoveryClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [recoveryOpen, recoveryRetryAt, recoveryClock]);

  const recoverySecondsRemaining = Math.max(
    0,
    Math.ceil((recoveryRetryAt - recoveryClock) / 1_000),
  );

  function startRecoveryCooldown(seconds: number) {
    const retryAt = Date.now() + seconds * 1_000;
    window.localStorage.setItem(
      RECOVERY_COOLDOWN_STORAGE_KEY,
      String(retryAt),
    );
    setRecoveryClock(Date.now());
    setRecoveryRetryAt(retryAt);
  }

  function openRecovery() {
    setRecoveryEmail(email);
    setRecoveryError("");
    setRecoveryMessage("");
    setRecoveryClock(Date.now());
    setRecoveryRetryAt(storedRecoveryRetryAt());
    setRecoveryOpen(true);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    try {
      await signIn(email, password);
      router.replace("/dashboard");
    } catch {
      // AuthProvider exposes the user-facing error.
    } finally {
      setSubmitting(false);
    }
  }

  async function recoverPassword(event: FormEvent) {
    event.preventDefault();
    if (recoverySecondsRemaining > 0) return;
    setRecoverySaving(true);
    setRecoveryError("");
    try {
      await requestPasswordRecovery(
        getSupabaseClient(),
        recoveryEmail,
        `${window.location.origin}/reset-password`,
      );
      setRecoveryMessage(
        "If an account exists for that email, a password-recovery link is on its way.",
      );
      startRecoveryCooldown(PASSWORD_RECOVERY_COOLDOWN_SECONDS);
    } catch (caught) {
      if (caught instanceof PasswordRecoveryRateLimitError) {
        startRecoveryCooldown(caught.retryAfterSeconds);
      }
      setRecoveryError(
        caught instanceof Error
          ? caught.message
          : "The recovery email could not be requested.",
      );
    } finally {
      setRecoverySaving(false);
    }
  }

  return (
    <main className="login-page product-auth-page">
      <section className="login-card" aria-labelledby="login-title">
        <div className="login-brand">
          <span className="brand-mark large" aria-hidden="true">CA</span>
          <span>Church Attendance</span>
        </div>
        <div>
          <p className="eyebrow">Authorized access</p>
          <h1 id="login-title">Welcome back</h1>
          <p className="muted">Sign in to prepare a service and record attendance.</p>
        </div>
        <form onSubmit={handleSubmit} className="form-stack">
          <label>
            Email address
            <input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>
          <label>
            Password
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>
          <button
            className="login-text-action"
            type="button"
            onClick={openRecovery}
          >
            Forgot password?
          </button>
          {error && <div className="notice error" role="alert">{error}</div>}
          <button className="button primary large full" disabled={submitting || loading}>
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <p className="login-help">Accounts are created by a church administrator.</p>
        <p className="login-offline-note">
          Your first sign-in on this device requires internet. After a successful
          sign-in, this device can reopen the attendance workspace offline.
        </p>
      </section>
      {recoveryOpen && (
        <div className="modal-backdrop">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="forgot-password-title"
          >
            <div className="modal-heading">
              <div>
                <p className="eyebrow">Account recovery</p>
                <h2 id="forgot-password-title">Reset your password</h2>
                <p>
                  Enter your authorized account email. Password setup requires
                  an internet connection.
                </p>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="Close password recovery"
                onClick={() => setRecoveryOpen(false)}
              >
                ×
              </button>
            </div>
            <form className="form-stack" onSubmit={recoverPassword}>
              <label>
                Email address
                <input
                  autoFocus
                  type="email"
                  autoComplete="email"
                  value={recoveryEmail}
                  onChange={(event) => setRecoveryEmail(event.target.value)}
                  required
                />
              </label>
              {recoveryMessage && (
                <div className="notice success" role="status">
                  {recoveryMessage}
                </div>
              )}
              {recoveryError && (
                <div className="notice error" role="alert">
                  {recoveryError}
                </div>
              )}
              <div className="modal-actions">
                <button
                  className="button subtle"
                  type="button"
                  onClick={() => setRecoveryOpen(false)}
                >
                  Close
                </button>
                <button
                  className="button primary"
                  disabled={recoverySaving || recoverySecondsRemaining > 0}
                >
                  {recoverySaving
                    ? "Sending…"
                    : recoverySecondsRemaining > 0
                      ? `Send again in ${recoverySecondsRemaining}s`
                      : recoveryMessage
                        ? "Send another email"
                        : "Send recovery email"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </main>
  );
}
