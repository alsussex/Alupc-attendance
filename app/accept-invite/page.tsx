"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { getSupabaseClient } from "@/lib/supabase/client";

export default function AcceptInvitePage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!navigator.onLine) {
      queueMicrotask(() =>
        setError("Accepting an invitation requires an internet connection."),
      );
      return;
    }
    void getSupabaseClient()
      .auth.getSession()
      .then(({ data }) => {
        setReady(Boolean(data.session));
        if (!data.session) {
          setError("Open the most recent invitation link from your email.");
        }
      });
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (password.length < 8) {
      setError("Use a password with at least eight characters.");
      return;
    }
    if (password !== confirmation) {
      setError("The passwords do not match.");
      return;
    }
    setSaving(true);
    const { error: updateError } = await getSupabaseClient().auth.updateUser({
      password,
    });
    if (updateError) {
      setError(updateError.message);
      setSaving(false);
      return;
    }
    router.replace("/dashboard");
  }

  return (
    <main className="login-page">
      <section className="login-card" aria-labelledby="invite-title">
        <div className="login-brand">
          <span className="brand-mark large" aria-hidden="true">AL</span>
          <span>Abundant Life UPC</span>
        </div>
        <div>
          <p className="eyebrow">Authorized attendance access</p>
          <h1 id="invite-title">Finish setting up your account</h1>
          <p className="muted">
            Choose a password for Church Attendance. Your first setup must be
            completed online.
          </p>
        </div>
        <form className="form-stack" onSubmit={submit}>
          <label>
            Password
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
          {error && <div className="notice error" role="alert">{error}</div>}
          <button className="button primary large full" disabled={!ready || saving}>
            {saving ? "Saving…" : "Complete account setup"}
          </button>
        </form>
      </section>
    </main>
  );
}
