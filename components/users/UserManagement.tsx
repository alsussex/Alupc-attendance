"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import type { UserRole } from "@/lib/domain";
import { getSupabaseClient } from "@/lib/supabase/client";

interface ManagedUser {
  id: string;
  displayName: string;
  email: string;
  role: UserRole;
  isActive: boolean;
  invitationStatus: "accepted" | "pending" | "not_invited" | "unknown";
  lastSignInAt?: string | null;
  invitedAt?: string | null;
  createdAt: string;
}

async function adminRequest(path = "", init?: RequestInit) {
  const {
    data: { session },
  } = await getSupabaseClient().auth.getSession();
  if (!session) throw new Error("Your authenticated session is required.");
  const response = await fetch(`/api/admin/users${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
      ...init?.headers,
    },
  });
  const body = (await response.json()) as {
    error?: string;
    users?: ManagedUser[];
  };
  if (!response.ok) throw new Error(body.error || "The request failed.");
  return body;
}

function formatDate(value?: string | null) {
  if (!value) return "Not yet";
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function UserManagement({ embedded = false }: { embedded?: boolean }) {
  const { user } = useAuth();
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [workingId, setWorkingId] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    if (!navigator.onLine) {
      setError("User management requires an internet connection.");
      setLoading(false);
      return;
    }
    try {
      const result = await adminRequest();
      setUsers(result.users ?? []);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Users could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  async function updateUser(
    target: ManagedUser,
    action: "role" | "disable" | "restore" | "resend",
    role?: UserRole,
  ) {
    setWorkingId(target.id);
    setError("");
    try {
      await adminRequest("", {
        method: "PATCH",
        body: JSON.stringify({ userId: target.id, action, role }),
      });
      setMessage(
        action === "resend"
          ? `Invitation sent again to ${target.email}.`
          : `${target.displayName} was updated.`,
      );
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The user could not be updated.");
    } finally {
      setWorkingId("");
    }
  }

  async function cancelInvitation(target: ManagedUser) {
    if (!confirm(`Cancel the invitation for ${target.email}?`)) return;
    setWorkingId(target.id);
    try {
      await adminRequest(`?userId=${encodeURIComponent(target.id)}`, {
        method: "DELETE",
      });
      setMessage(`Invitation for ${target.email} was cancelled.`);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The invitation could not be cancelled.");
    } finally {
      setWorkingId("");
    }
  }

  return (
    <div className="page-stack">
      <div className={embedded ? "settings-embedded-heading" : "page-heading with-action"}>
        <div>
          <p className="eyebrow">Administrator</p>
          <h1>User Management</h1>
          <p>Invite trusted volunteers to the existing Abundant Life UPC organization.</p>
        </div>
        <button
          className="button primary"
          type="button"
          onClick={() => setInviteOpen(true)}
        >
          ＋ Invite user
        </button>
      </div>

      <div className="admin-safety-note">
        <span aria-hidden="true">i</span>
        <p>
          New users must accept their invitation online. After their first
          successful sign-in, that device can reopen the attendance workspace
          offline.
        </p>
      </div>
      {message && <div className="notice success" role="status">{message}</div>}
      {error && <div className="notice error" role="alert">{error}</div>}

      <section className="panel users-panel" aria-label="Authorized church users">
        <div className="users-table-header" aria-hidden="true">
          <span>User</span>
          <span>Role</span>
          <span>Status</span>
          <span>Last sign-in</span>
          <span>Added</span>
          <span>Actions</span>
        </div>
        {loading ? (
          <div className="empty-list">Loading authorized users…</div>
        ) : (
          <div className="users-list">
            {users.map((managedUser) => {
              const pending = managedUser.invitationStatus === "pending";
              const working = workingId === managedUser.id;
              return (
                <article className="user-row" key={managedUser.id}>
                  <div className="user-identity">
                    <span className="avatar" aria-hidden="true">
                      {managedUser.displayName
                        .split(/\s+/)
                        .slice(0, 2)
                        .map((part) => part[0])
                        .join("")
                        .toUpperCase()}
                    </span>
                    <span>
                      <strong>{managedUser.displayName}</strong>
                      <small>{managedUser.email}</small>
                    </span>
                  </div>
                  <label className="user-role-field">
                    <span className="sr-only">
                      Role for {managedUser.displayName}
                    </span>
                    <select
                      value={managedUser.role}
                      disabled={working || !managedUser.isActive}
                      onChange={(event) =>
                        void updateUser(
                          managedUser,
                          "role",
                          event.target.value as UserRole,
                        )
                      }
                    >
                      <option value="admin">Admin</option>
                      <option value="attendance_taker">Attendance Taker</option>
                    </select>
                  </label>
                  <span>
                    <span
                      className={
                        managedUser.isActive
                          ? pending
                            ? "account-pill pending"
                            : "account-pill active"
                          : "account-pill disabled"
                      }
                    >
                      {!managedUser.isActive
                        ? "Disabled"
                        : pending
                          ? "Invitation pending"
                          : "Active"}
                    </span>
                  </span>
                  <span className="user-date">
                    {formatDate(managedUser.lastSignInAt)}
                  </span>
                  <span className="user-date">
                    {formatDate(managedUser.createdAt)}
                  </span>
                  <div className="user-actions">
                    {pending && (
                      <>
                        <button
                          className="button subtle"
                          type="button"
                          disabled={working}
                          onClick={() => void updateUser(managedUser, "resend")}
                        >
                          Resend
                        </button>
                        <button
                          className="button danger-text"
                          type="button"
                          disabled={working}
                          onClick={() => void cancelInvitation(managedUser)}
                        >
                          Cancel
                        </button>
                      </>
                    )}
                    {!pending &&
                      (managedUser.isActive ? (
                        <button
                          className="button danger-text"
                          type="button"
                          disabled={working || managedUser.id === user?.userId}
                          onClick={() => void updateUser(managedUser, "disable")}
                        >
                          Disable
                        </button>
                      ) : (
                        <button
                          className="button subtle"
                          type="button"
                          disabled={working}
                          onClick={() => void updateUser(managedUser, "restore")}
                        >
                          Restore
                        </button>
                      ))}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {inviteOpen && (
        <InviteUserModal
          onClose={() => setInviteOpen(false)}
          onInvited={async (email) => {
            setInviteOpen(false);
            setMessage(`Invitation sent to ${email}.`);
            await refresh();
          }}
        />
      )}
    </div>
  );
}

function InviteUserModal({
  onClose,
  onInvited,
}: {
  onClose: () => void;
  onInvited: (email: string) => Promise<void>;
}) {
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<UserRole>("attendance_taker");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await adminRequest("", {
        method: "POST",
        body: JSON.stringify({ displayName, email, role }),
      });
      await onInvited(email);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The invitation could not be sent.");
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="invite-user-title"
      >
        <div className="modal-heading">
          <div>
            <p className="eyebrow">Abundant Life UPC</p>
            <h2 id="invite-user-title">Invite an authorized user</h2>
          </div>
          <button
            className="icon-button"
            aria-label="Close"
            type="button"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <form className="form-stack" onSubmit={submit}>
          <label>
            Display name
            <input
              autoFocus
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              required
            />
          </label>
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
            Role
            <select
              value={role}
              onChange={(event) => setRole(event.target.value as UserRole)}
            >
              <option value="attendance_taker">Attendance Taker</option>
              <option value="admin">Admin</option>
            </select>
          </label>
          {error && <div className="notice error" role="alert">{error}</div>}
          <div className="modal-actions">
            <button className="button subtle" type="button" onClick={onClose}>
              Cancel
            </button>
            <button className="button primary" disabled={saving}>
              {saving ? "Sending invitation…" : "Send invitation"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
