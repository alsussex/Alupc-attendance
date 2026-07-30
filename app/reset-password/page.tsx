"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/feedback/ToastProvider";
import {
  passwordConfirmationError,
  preparePasswordSetupSession,
} from "@/lib/auth/password";
import { getSupabaseClient } from "@/lib/supabase/client";

export default function ResetPasswordPage() {
  const router = useRouter();
  const { showToast } = useToast();
  const [ready, setReady] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!navigator.onLine) {
      queueMicrotask(() =>
        setError("Setting a new password requires an internet connection."),
      );
      return;
    }
    void preparePasswordSetupSession(
      getSupabaseClient(),
      window.location.href,
      "recovery",
    )
      .then(() => setReady(true))
      .catch((caught) =>
        setError(
          caught instanceof Error
            ? caught.message
            : "This password-recovery link could not be used.",
        ),
      );
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const validation = passwordConfirmationError(password, confirmation);
    if (validation) {
      setError(validation);
      return;
    }
    setSaving(true);
    setError("");
    const { error: updateError } = await getSupabaseClient().auth.updateUser({
      password,
    });
    if (updateError) {
      setError(
        /expired|invalid|session|token/i.test(updateError.message)
          ? "This password-recovery link is invalid, expired, or has already been used. Request a new link."
          : "Your password could not be updated. Please try again.",
      );
      setSaving(false);
      return;
    }
    showToast("Password updated.", { key: "password-updated" });
    router.replace("/dashboard");
  }

  return (
    <main className="login-page">
      <section className="login-card" aria-labelledby="reset-password-title">
        <div className="login-brand">
          <span className="brand-mark large" aria-hidden="true">
            AL
          </span>
          <span>Abundant Life UPC</span>
        </div>
        <div>
          <p className="eyebrow">Account recovery</p>
          <h1 id="reset-password-title">Set a new password</h1>
          <p className="muted">
            Choose a new password before continuing to Church Attendance.
          </p>
        </div>
        <form className="form-stack" onSubmit={submit}>
          <label>
            New password
            <input
              type="password"
              autoComplete="new-password"
              minLength={8}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={!ready}
              required
            />
          </label>
          <label>
            Confirm password
            <input
              type="password"
              autoComplete="new-password"
              minLength={8}
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              disabled={!ready}
              required
            />
          </label>
          {error && (
            <div className="notice error" role="alert">
              {error}
            </div>
          )}
          <button
            className="button primary large full"
            disabled={!ready || saving}
          >
            {saving ? "Updating…" : "Update password"}
          </button>
        </form>
        {!ready && (
          <a className="login-text-action" href="/login">
            Return to sign in
          </a>
        )}
      </section>
    </main>
  );
}
