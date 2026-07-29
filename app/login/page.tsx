"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/auth/AuthProvider";

export default function LoginPage() {
  const { loading, user, error, signIn } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

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
          {error && <div className="notice error" role="alert">{error}</div>}
          <button className="button primary large full" disabled={submitting || loading}>
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <p className="login-help">Accounts are created by a church administrator.</p>
      </section>
    </main>
  );
}
