"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { AuditHistory } from "@/components/audit/AuditHistory";
import { removeLocalAuditEntriesForUser } from "@/lib/audit/audit-repository";
import type { UserRole } from "@/lib/domain";
import { getSupabaseClient } from "@/lib/supabase/client";
import { passwordConfirmationError } from "@/lib/auth/password";
import { useToast } from "@/components/feedback/ToastProvider";
import { useConfirmation } from "@/components/feedback/ConfirmationProvider";
import { EmptyState } from "@/components/feedback/EmptyState";
import { LoadingSkeleton } from "@/components/feedback/LoadingSkeleton";
import { formatDateTime } from "@/lib/format/date-time";
import { useEscapeKey } from "@/lib/ui/keyboard";

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
  canReopenCompletedServices: boolean;
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

export function UserManagement({ embedded = false }: { embedded?: boolean }) {
  const { user } = useAuth();
  const { showToast } = useToast();
  const confirmAction = useConfirmation();
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [workingId, setWorkingId] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [historyUser, setHistoryUser] = useState<ManagedUser | null>(null);
  const [deletingUser, setDeletingUser] = useState<ManagedUser | null>(null);
  const [permissionUser, setPermissionUser] = useState<ManagedUser | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEscapeKey(
    () => {
      if (deletingUser) setDeletingUser(null);
      else if (permissionUser) setPermissionUser(null);
      else if (historyUser) setHistoryUser(null);
      else if (createOpen) setCreateOpen(false);
      else if (inviteOpen) setInviteOpen(false);
    },
    Boolean(deletingUser || permissionUser || historyUser || createOpen || inviteOpen),
  );

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
    if (
      !(await confirmAction({
        title: "Cancel this invitation?",
        message: `${target.email} will no longer be able to use the pending invitation link.`,
        confirmLabel: "Cancel invitation",
        tone: "danger",
      }))
    ) {
      return;
    }
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
    <div className="page-stack product-subpage users-product-page">
      <div className={embedded ? "settings-embedded-heading" : "page-heading with-action"}>
        <div>
          <p className="eyebrow">Administrator</p>
          <h1>User Management</h1>
          <p>Invite trusted volunteers to the existing Abundant Life UPC organization.</p>
        </div>
        <div className="button-row">
          <button
            className="button secondary"
            type="button"
            onClick={() => setInviteOpen(true)}
          >
            Invite User
          </button>
          <button
            className="button primary"
            type="button"
            onClick={() => setCreateOpen(true)}
          >
            Create User
          </button>
        </div>
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

      <section className="users-directory" aria-label="Authorized church users">
        <div className="users-table-header" aria-hidden="true">
          <span>User</span>
          <span>Role</span>
          <span>Status</span>
          <span>Last sign-in</span>
          <span>Added</span>
        </div>
        {loading ? (
          <LoadingSkeleton label="Loading authorized users" rows={4} />
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
                    {formatDateTime(managedUser.lastSignInAt, "Not yet")}
                  </span>
                  <span className="user-date">
                    {formatDateTime(managedUser.createdAt, "Not yet")}
                  </span>
                  <div
                    className="user-actions"
                    aria-label={`Account actions for ${managedUser.displayName}`}
                  >
                    <span className="user-actions-label">Account actions</span>
                    <button
                      className="button subtle"
                      type="button"
                      disabled={working}
                      onClick={() => setHistoryUser(managedUser)}
                    >
                      History
                    </button>
                    {managedUser.role === "attendance_taker" && (
                      <button
                        className="button subtle"
                        type="button"
                        disabled={working}
                        onClick={() => setPermissionUser(managedUser)}
                      >
                        Permissions
                      </button>
                    )}
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
                    <button
                      className="button danger user-delete-button"
                      type="button"
                      disabled={working || managedUser.id === user?.userId}
                      title={
                        managedUser.id === user?.userId
                          ? "You cannot delete your currently signed-in account."
                          : undefined
                      }
                      onClick={() => setDeletingUser(managedUser)}
                    >
                      Delete User
                    </button>
                    {managedUser.id === user?.userId && (
                      <span className="user-self-delete-note">
                        Your currently signed-in account cannot be deleted here.
                      </span>
                    )}
                  </div>
                </article>
              );
            })}
            {users.length === 0 && (
              <EmptyState
                compact
                icon="+"
                title="No additional users yet"
                message="Invite or create a trusted church volunteer when you are ready."
              />
            )}
          </div>
        )}
      </section>

      {historyUser && (
        <div className="modal-backdrop">
          <section
            className="modal audit-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="user-history-title"
          >
            <div className="modal-heading">
              <div>
                <p className="eyebrow">User history</p>
                <h2 id="user-history-title">{historyUser.displayName}</h2>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="Close user history"
                onClick={() => setHistoryUser(null)}
              >
                ×
              </button>
            </div>
            <AuditHistory
              entityType="user"
              entityId={historyUser.id}
              compact
            />
          </section>
        </div>
      )}

      {deletingUser && (
        <DeleteUserModal
          target={deletingUser}
          organizationId={user?.organizationId ?? ""}
          onClose={() => setDeletingUser(null)}
          onDeleted={async (historyDeleted) => {
            const deleted = deletingUser;
            setDeletingUser(null);
            setMessage(
              historyDeleted
                ? `${deleted.displayName}'s account and audit history were permanently deleted.`
                : `${deleted.displayName}'s account was deleted. Audit history was preserved.`,
            );
            showToast("User account deleted.", {
              key: `deleted-user:${deleted.id}`,
            });
            await refresh();
          }}
        />
      )}

      {permissionUser && (
        <UserPermissionsModal
          target={permissionUser}
          onClose={() => setPermissionUser(null)}
          onSaved={async () => {
            setPermissionUser(null);
            setMessage(`${permissionUser.displayName}'s permissions were updated.`);
            await refresh();
          }}
        />
      )}

      {inviteOpen && (
        <InviteUserModal
          onClose={() => setInviteOpen(false)}
          onInvited={async (email) => {
            setInviteOpen(false);
            setMessage(`Invitation sent to ${email}.`);
            showToast("Invitation sent.", { key: `invite:${email}` });
            await refresh();
          }}
        />
      )}
      {createOpen && (
        <CreateUserModal
          onClose={() => setCreateOpen(false)}
          onCreated={async (email) => {
            setCreateOpen(false);
            setMessage(`User account created for ${email}.`);
            showToast("User created.", { key: `created-user:${email}` });
            await refresh();
          }}
        />
      )}
    </div>
  );
}

function UserPermissionsModal({
  target,
  onClose,
  onSaved,
}: {
  target: ManagedUser;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [enabled, setEnabled] = useState(target.canReopenCompletedServices);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      await adminRequest("", {
        method: "PATCH",
        body: JSON.stringify({
          userId: target.id,
          action: "permission",
          canReopenCompletedServices: enabled,
        }),
      });
      await onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Permissions could not be updated.");
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="user-permissions-title">
        <div className="modal-heading">
          <div>
            <p className="eyebrow">User Permissions</p>
            <h2 id="user-permissions-title">{target.displayName}</h2>
          </div>
          <button className="icon-button" type="button" aria-label="Close permissions" onClick={onClose} disabled={saving}>×</button>
        </div>
        <p>Additional access beyond the standard Attendance Taker role.</p>
        <form className="form-stack" onSubmit={submit}>
          <label className="settings-toggle">
            <span>
              <strong>Reopen completed services</strong>
              <small>Allow this user to reopen a completed service and make corrections to its attendance.</small>
            </span>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
              disabled={saving}
            />
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="modal-actions">
            <button className="button subtle" type="button" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="button primary" type="submit" disabled={saving}>{saving ? "Saving…" : "Save permissions"}</button>
          </div>
        </form>
      </section>
    </div>
  );
}

function DeleteUserModal({
  target,
  organizationId,
  onClose,
  onDeleted,
}: {
  target: ManagedUser;
  organizationId: string;
  onClose: () => void;
  onDeleted: (historyDeleted: boolean) => Promise<void>;
}) {
  const [mode, setMode] = useState<
    "preserve_history" | "delete_history"
  >("preserve_history");
  const [confirmation, setConfirmation] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (mode === "delete_history" && confirmation !== "DELETE") {
      setError("Type DELETE to permanently remove this user's history.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await adminRequest(
        `?userId=${encodeURIComponent(target.id)}&action=delete`,
        {
          method: "DELETE",
          body: JSON.stringify({ mode, confirmation }),
        },
      );
      if (mode === "delete_history") {
        try {
          await removeLocalAuditEntriesForUser(organizationId, target.id);
        } catch (caught) {
          if (process.env.NODE_ENV === "development") {
            console.warn(
              "[users] account deleted; local audit cleanup will retry from the server marker",
              caught,
            );
          }
        }
      }
      await onDeleted(mode === "delete_history");
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The user account could not be deleted.",
      );
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <section
        className="modal delete-user-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-user-title"
      >
        <div className="modal-heading">
          <div>
            <p className="eyebrow">Permanent account deletion</p>
            <h2 id="delete-user-title">Delete {target.displayName}?</h2>
            <p>
              This permanently removes the authentication account and church
              user profile. Member, service, attendance, visitor, and note data
              will not be changed.
            </p>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Close account deletion"
            disabled={saving}
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <form className="form-stack" onSubmit={submit}>
          <fieldset className="deletion-options">
            <legend>Choose how history should be handled</legend>
            <label
              className={
                mode === "preserve_history"
                  ? "deletion-option selected"
                  : "deletion-option"
              }
            >
              <input
                autoFocus
                type="radio"
                name="history-mode"
                value="preserve_history"
                checked={mode === "preserve_history"}
                onChange={() => {
                  setMode("preserve_history");
                  setConfirmation("");
                  setError("");
                }}
              />
              <span>
                <strong>Delete account and keep audit history</strong>
                <small>
                  Recommended. Past actions keep the recorded user name and
                  remain understandable.
                </small>
              </span>
            </label>
            <label
              className={
                mode === "delete_history"
                  ? "deletion-option destructive selected"
                  : "deletion-option destructive"
              }
            >
              <input
                type="radio"
                name="history-mode"
                value="delete_history"
                checked={mode === "delete_history"}
                onChange={() => {
                  setMode("delete_history");
                  setError("");
                }}
              />
              <span>
                <strong>Delete account and delete audit history</strong>
                <small>
                  Permanently removes every audit entry created by this user.
                  This cannot be undone.
                </small>
              </span>
            </label>
          </fieldset>
          {mode === "delete_history" && (
            <label>
              Type DELETE to confirm permanent history deletion
              <input
                value={confirmation}
                autoComplete="off"
                onChange={(event) => setConfirmation(event.target.value)}
                required
              />
            </label>
          )}
          {error && (
            <div className="notice error" role="alert">
              {error}
            </div>
          )}
          <div className="modal-actions">
            <button
              className="button subtle"
              type="button"
              disabled={saving}
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              className="button danger"
              type="submit"
              disabled={
                saving ||
                (mode === "delete_history" && confirmation !== "DELETE")
              }
            >
              {saving
                ? "Deleting…"
                : mode === "delete_history"
                  ? "Delete Account and History"
                  : "Delete Account"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function CreateUserModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (email: string) => Promise<void>;
}) {
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [role, setRole] = useState<UserRole>("attendance_taker");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    const validation = passwordConfirmationError(password, confirmation);
    if (validation) {
      setError(validation);
      return;
    }
    setSaving(true);
    setError("");
    try {
      await adminRequest("", {
        method: "POST",
        body: JSON.stringify({
          mode: "create",
          displayName,
          email,
          password,
          role,
        }),
      });
      await onCreated(email);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The user account could not be created.",
      );
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-user-title"
      >
        <div className="modal-heading">
          <div>
            <p className="eyebrow">Secure administrator action</p>
            <h2 id="create-user-title">Create an authorized user</h2>
            <p>
              This account is created immediately in the current church
              organization. Share the initial password securely.
            </p>
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
          <div className="form-grid">
            <label>
              Initial password
              <input
                type="password"
                autoComplete="new-password"
                minLength={8}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
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
                required
              />
            </label>
          </div>
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
          {error && (
            <div className="notice error" role="alert">
              {error}
            </div>
          )}
          <div className="modal-actions">
            <button
              className="button subtle"
              type="button"
              disabled={saving}
              onClick={onClose}
            >
              Cancel
            </button>
            <button className="button primary" disabled={saving}>
              {saving ? "Creating…" : "Create User"}
            </button>
          </div>
        </form>
      </section>
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
