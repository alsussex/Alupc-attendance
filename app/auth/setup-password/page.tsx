"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { getSupabaseClient } from "@/lib/supabase/client";
import {
  passwordConfirmationError,
  preparePasswordSetupSession,
} from "@/lib/auth/password";
import { useToast } from "@/components/feedback/ToastProvider";

export default function AcceptInvitePage() {
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
        setError("Accepting an invitation requires an internet connection."),
      );
      return;
    }
    void preparePasswordSetupSession(
      getSupabaseClient(),
      window.location.href,
      "invite",
    )
      .then(() => {
        window.history.replaceState(
          {},
          document.title,
          "/auth/setup-password",
        );
        setReady(true);
      })
      .catch((caught) =>
        setError(
          caught instanceof Error
            ? caught.message
            : "Open the most recent invitation link from your email.",
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
          ? "This invitation link is invalid, expired, or has already been used. Ask an administrator to resend it."
          : "Your password could not be saved. Please try again.",
      );
      setSaving(false);
      return;
    }
    const client = getSupabaseClient();
    const {
      data: { user },
    } = await client.auth.getUser();
    if (user) {
      const { data: profile } = await client
        .from("profiles")
        .select("organization_id, display_name, role")
        .eq("id", user.id)
        .single();
      if (profile) {
        const auditId = crypto.randomUUID();
        await client.from("audit_log").insert({
          id: auditId,
          organization_id: profile.organization_id,
          entity_type: "user",
          entity_id: user.id,
          action: "invitation_accepted",
          user_id: user.id,
          user_display_name: profile.display_name || user.email || "Church user",
          role: profile.role,
          details: {},
          version: 1,
          last_mutation_id: auditId,
        });
      }
    }
    showToast("Account setup complete.", { key: "invitation-accepted" });
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
          <h1 id="invite-title">Set your password</h1>
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
            {saving ? "Saving…" : "Set password and continue"}
          </button>
        </form>
      </section>
    </main>
  );
}
