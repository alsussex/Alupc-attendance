"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/auth/AuthProvider";
import {
  requestPasswordRecovery,
} from "@/lib/auth/password";
import { getSupabaseClient } from "@/lib/supabase/client";
import { useEscapeKey } from "@/lib/ui/keyboard";

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

  useEscapeKey(() => setRecoveryOpen(false), recoveryOpen);

  useEffect(() => {
    if (!loading && user) router.replace("/dashboard");
  }, [loading, user, router]);

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
    } catch (caught) {
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
    <main className="login-page">
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
            onClick={() => {
              setRecoveryEmail(email);
              setRecoveryOpen(true);
            }}
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
                {!recoveryMessage && (
                  <button
                    className="button primary"
                    disabled={recoverySaving}
                  >
                    {recoverySaving ? "Sending…" : "Send recovery email"}
                  </button>
                )}
              </div>
            </form>
          </section>
        </div>
      )}
    </main>
  );
}
