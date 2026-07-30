"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { AuditHistory } from "@/components/audit/AuditHistory";
import { BulkMemberEntryModal } from "@/components/people/BulkMemberEntryModal";
import { isAdmin } from "@/lib/auth/permissions";
import type { Person } from "@/lib/domain";
import {
  DEFAULT_MEMBER_DIRECTORY_VIEW,
  filterDirectoryMembers,
  type MemberDirectoryView,
} from "@/lib/people/member-directory";
import { sortMembersByLastName } from "@/lib/people/bulk-member-entry";
import {
  findExactMemberMatches,
  getLastAttendanceDates,
  listActiveMembers,
  listMemberCandidates,
  listMembers,
  markMemberInactive,
  removeMember,
  restoreMember,
  saveMember,
} from "@/lib/repositories/attendance-repository";
import { subscribeToDataChanges } from "@/lib/storage/data-events";

interface FormState {
  id?: string;
  firstName: string;
  lastName: string;
}

const emptyForm: FormState = { firstName: "", lastName: "" };

function formatDate(value?: string | null) {
  if (!value) return "Not available";
  const date = new Date(value.length === 10 ? `${value}T12:00:00` : value);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function PeopleDirectory() {
  const { user } = useAuth();
  const [people, setPeople] = useState<Person[]>([]);
  const [memberCandidates, setMemberCandidates] = useState<Person[]>([]);
  const [lastAttendance, setLastAttendance] = useState<Map<string, string>>(
    new Map(),
  );
  const [query, setQuery] = useState("");
  const [view, setView] = useState<MemberDirectoryView>(
    DEFAULT_MEMBER_DIRECTORY_VIEW,
  );
  const [form, setForm] = useState<FormState | null>(null);
  const [profile, setProfile] = useState<Person | null>(null);
  const [reactivateTarget, setReactivateTarget] = useState<Person | null>(null);
  const [duplicate, setDuplicate] = useState<Person | null>(null);
  const [multipleMatches, setMultipleMatches] = useState<Person[]>([]);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    if (!user) return;
    const [members, candidates, dates] = await Promise.all([
      isAdmin(user)
        ? listMembers(user.organizationId)
        : listActiveMembers(user.organizationId),
      listMemberCandidates(user.organizationId),
      getLastAttendanceDates(user.organizationId),
    ]);
    setPeople(members);
    setMemberCandidates(candidates);
    setLastAttendance(dates);
    setProfile((current) =>
      current ? members.find((member) => member.id === current.id) ?? null : null,
    );
  }, [user]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    const unsubscribe = subscribeToDataChanges(() => void refresh());
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [refresh]);

  const effectiveView = isAdmin(user) ? view : "active";
  const filtered = useMemo(
    () =>
      sortMembersByLastName(
        filterDirectoryMembers(people, effectiveView, query),
      ),
    [effectiveView, people, query],
  );

  const inactiveCount = people.filter((person) => !person.isActive).length;

  async function submit(
    event: Pick<FormEvent, "preventDefault">,
    allowDuplicate = false,
  ) {
    event.preventDefault();
    if (!form || !user) return;
    if (!form.id && !allowDuplicate) {
      const matches = await findExactMemberMatches(
        user.organizationId,
        `${form.firstName} ${form.lastName}`,
      );
      if (matches.length > 1) {
        setMultipleMatches(matches);
        return;
      }
      const match = matches[0];
      if (match?.isActive && !match.deletedAt) {
        setDuplicate(match);
        return;
      }
      if (match) {
        setReactivateTarget(match);
        setForm(null);
        return;
      }
    }
    setSaving(true);
    await saveMember(user, { ...form, allowDuplicate });
    setSaving(false);
    setForm(null);
    setDuplicate(null);
    await refresh();
  }

  async function deactivate(person: Person) {
    if (!user || !confirm(`Mark ${person.displayName} inactive?`)) return;
    await markMemberInactive(user, person.id);
    await refresh();
  }

  async function reactivate() {
    if (!user || !reactivateTarget) return;
    const target = reactivateTarget;
    setSaving(true);
    await restoreMember(user, target.id);
    setSaving(false);
    setReactivateTarget(null);
    setProfile(null);
    await refresh();
  }

  async function remove(person: Person) {
    if (
      !user ||
      !confirm(
        `Remove ${person.displayName}? Their historical attendance will remain preserved.`,
      )
    ) {
      return;
    }
    await removeMember(user, person.id);
    setProfile(null);
    await refresh();
  }

  function edit(person: Person) {
    setProfile(null);
    setForm({
      id: person.id,
      firstName: person.firstName,
      lastName: person.lastName,
    });
  }

  return (
    <div className="page-stack">
      <div className="page-heading with-action">
        <div>
          <p className="eyebrow">Directory</p>
          <h1>People</h1>
          <p>Active members appear automatically when you record a service.</p>
        </div>
        <div className="button-row people-add-actions">
          <button
            className="button secondary"
            type="button"
            onClick={() => setBulkOpen(true)}
          >
            Add Multiple Members
          </button>
          <button
            className="button primary"
            type="button"
            onClick={() => {
              setDuplicate(null);
              setForm(emptyForm);
            }}
          >
            <span aria-hidden="true">＋</span> Add member
          </button>
        </div>
      </div>

      <section className="panel">
        {isAdmin(user) && (
          <div
            className="member-filter-tabs"
            role="tablist"
            aria-label="Filter church members"
          >
            {(
              [
                ["active", "Active Members"],
                ["inactive", `Inactive Members (${inactiveCount})`],
                ["all", "All Members"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                className={effectiveView === value ? "active" : ""}
                type="button"
                role="tab"
                aria-selected={effectiveView === value}
                onClick={() => setView(value)}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        <div className="panel-toolbar">
          <label className="search-field">
            <span className="sr-only">Search {effectiveView} members</span>
            <span aria-hidden="true">⌕</span>
            <input
              type="search"
              placeholder={`Search ${effectiveView === "all" ? "" : `${effectiveView} `}members by name`}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <span className="count-label">
            {filtered.length}{" "}
            {effectiveView === "all" ? "total" : effectiveView} members
          </span>
        </div>

        <div className="person-list">
          {filtered.map((person) => (
            <article
              className={`person-row ${person.isActive ? "" : "inactive"}`}
              key={person.id}
            >
              <span className="avatar" aria-hidden="true">
                {person.firstName[0]}
                {person.lastName[0]}
              </span>
              <div className="person-name">
                <strong>{person.displayName}</strong>
                <span className="person-meta">
                  <span
                    className={
                      person.isActive
                        ? "member-status active"
                        : "member-status inactive"
                    }
                  >
                    {person.isActive ? "Active" : "Inactive"}
                  </span>
                  {!person.isActive && (
                    <>
                      <span>
                        Last attendance:{" "}
                        {formatDate(lastAttendance.get(person.id))}
                      </span>
                      <span>Inactive since: {formatDate(person.inactiveAt)}</span>
                    </>
                  )}
                </span>
              </div>
              <div className="row-actions">
                <button
                  className="button subtle"
                  type="button"
                  onClick={() => setProfile(person)}
                >
                  View profile
                </button>
                <button
                  className="button subtle"
                  type="button"
                  onClick={() => edit(person)}
                >
                  Edit
                </button>
                {isAdmin(user) &&
                  (person.isActive ? (
                    <button
                      className="button danger-text"
                      type="button"
                      onClick={() => void deactivate(person)}
                    >
                      Make inactive
                    </button>
                  ) : (
                    <>
                      <button
                        className="button secondary"
                        type="button"
                        onClick={() => setReactivateTarget(person)}
                      >
                        Reactivate
                      </button>
                      <button
                        className="button danger-text"
                        type="button"
                        onClick={() => void remove(person)}
                      >
                        Remove
                      </button>
                    </>
                  ))}
              </div>
            </article>
          ))}
          {!filtered.length && (
            <div className="empty-list">
              <h2>
                {effectiveView === "inactive"
                  ? "No inactive members"
                  : "No members found"}
              </h2>
              <p>
                {query
                  ? "Try a different search."
                  : effectiveView === "inactive"
                    ? "Members made inactive will appear here."
                    : "Add your first member to begin."}
              </p>
            </div>
          )}
        </div>
      </section>

      {profile && (
        <MemberProfileModal
          person={profile}
          lastAttendanceDate={lastAttendance.get(profile.id)}
          canManageLifecycle={isAdmin(user)}
          onClose={() => setProfile(null)}
          onEdit={() => edit(profile)}
          onReactivate={() => {
            setReactivateTarget(profile);
            setProfile(null);
          }}
        />
      )}

      {reactivateTarget && (
        <div className="modal-backdrop">
          <section
            className="modal confirmation-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="reactivate-title"
            aria-describedby="reactivate-description"
            onKeyDown={(event) => {
              if (event.key === "Escape") setReactivateTarget(null);
            }}
          >
            <div>
              <p className="eyebrow">Member access</p>
              <h2 id="reactivate-title">
                {reactivateTarget.deletedAt ? "Restore" : "Reactivate"}{" "}
                {reactivateTarget.displayName}?
              </h2>
              <p id="reactivate-description">
                {reactivateTarget.deletedAt
                  ? "A previously removed member with this name already exists. Would you like to restore them?"
                  : "An inactive member with this name already exists. Would you like to reactivate the existing member instead?"}
              </p>
            </div>
            <div className="modal-actions">
              <button
                className="button subtle"
                type="button"
                autoFocus
                disabled={saving}
                onClick={() => setReactivateTarget(null)}
              >
                Cancel
              </button>
              <button
                className="button primary"
                type="button"
                disabled={saving}
                onClick={() => void reactivate()}
              >
                {reactivateTarget.deletedAt
                  ? "Restore Existing Member"
                  : "Reactivate Existing Member"}
              </button>
            </div>
          </section>
        </div>
      )}

      {multipleMatches.length > 0 && (
        <div className="modal-backdrop">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="member-match-title"
          >
            <div className="modal-heading">
              <div>
                <p className="eyebrow">Possible matches</p>
                <h2 id="member-match-title">Choose the correct member</h2>
                <p>
                  Multiple people share this name. Select an existing record or
                  explicitly create a separate person.
                </p>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="Close member matches"
                onClick={() => setMultipleMatches([])}
              >
                ×
              </button>
            </div>
            <div className="member-match-list">
              {multipleMatches.map((match) => (
                <article key={match.id}>
                  <div>
                    <strong>{match.displayName}</strong>
                    <span>
                      {match.deletedAt
                        ? "Removed"
                        : match.isActive
                          ? "Active"
                          : "Inactive"}{" "}
                      · Added {formatDate(match.createdAt)} · Last attendance{" "}
                      {formatDate(lastAttendance.get(match.id))}
                    </span>
                  </div>
                  <button
                    className="button secondary"
                    type="button"
                    onClick={() => {
                      setMultipleMatches([]);
                      setForm(null);
                      if (match.isActive && !match.deletedAt) {
                        setProfile(match);
                      } else {
                        setReactivateTarget(match);
                      }
                    }}
                  >
                    {match.isActive && !match.deletedAt
                      ? "Open member"
                      : "Restore member"}
                  </button>
                </article>
              ))}
            </div>
            <div className="modal-actions">
              <button
                className="button subtle"
                type="button"
                onClick={() => setMultipleMatches([])}
              >
                Cancel
              </button>
              <button
                className="button primary"
                type="button"
                onClick={(event) => {
                  setMultipleMatches([]);
                  void submit(event, true);
                }}
              >
                Create separate person
              </button>
            </div>
          </section>
        </div>
      )}

      {form && (
        <div className="modal-backdrop" role="presentation">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="person-form-title"
          >
            <div className="modal-heading">
              <div>
                <p className="eyebrow">People directory</p>
                <h2 id="person-form-title">
                  {form.id ? "Edit member" : "Add a member"}
                </h2>
              </div>
              <button
                className="icon-button"
                aria-label="Close"
                type="button"
                onClick={() => {
                  setDuplicate(null);
                  setForm(null);
                }}
              >
                ×
              </button>
            </div>
            <form className="form-stack" onSubmit={submit}>
              <div className="form-grid">
                <label>
                  First name
                  <input
                    autoFocus
                    value={form.firstName}
                    onChange={(event) => {
                      setDuplicate(null);
                      setForm({ ...form, firstName: event.target.value });
                    }}
                    required
                  />
                </label>
                <label>
                  Last name
                  <input
                    value={form.lastName}
                    onChange={(event) => {
                      setDuplicate(null);
                      setForm({ ...form, lastName: event.target.value });
                    }}
                  />
                </label>
              </div>
              {duplicate && (
                <div className="notice warning" role="alert">
                  <strong>This member already exists.</strong>
                  <span>
                    {duplicate.displayName} is already in the active directory.
                  </span>
                  <button
                    className="button subtle"
                    type="button"
                    onClick={() => {
                      setForm(null);
                      setProfile(duplicate);
                      setDuplicate(null);
                    }}
                  >
                    Open existing member
                  </button>
                </div>
              )}
              <div className="modal-actions">
                <button
                  className="button subtle"
                  type="button"
                  onClick={() => {
                    setDuplicate(null);
                    setForm(null);
                  }}
                >
                  Cancel
                </button>
                <button
                  className="button primary"
                  disabled={saving || Boolean(duplicate)}
                >
                  Save member
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
      {bulkOpen && (
        <BulkMemberEntryModal
          candidates={memberCandidates}
          lastAttendance={lastAttendance}
          onClose={() => setBulkOpen(false)}
          onCompleted={refresh}
        />
      )}
    </div>
  );
}

function MemberProfileModal({
  person,
  lastAttendanceDate,
  canManageLifecycle,
  onClose,
  onEdit,
  onReactivate,
}: {
  person: Person;
  lastAttendanceDate?: string;
  canManageLifecycle: boolean;
  onClose: () => void;
  onEdit: () => void;
  onReactivate: () => void;
}) {
  return (
    <div className="modal-backdrop">
      <section
        className="modal member-profile"
        role="dialog"
        aria-modal="true"
        aria-labelledby="member-profile-title"
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      >
        <div className="modal-heading">
          <div>
            <p className="eyebrow">Member profile</p>
            <h2 id="member-profile-title">{person.displayName}</h2>
          </div>
          <button
            className="icon-button"
            aria-label="Close member profile"
            type="button"
            autoFocus
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <dl className="member-profile-details">
          <div>
            <dt>Status</dt>
            <dd>
              <span
                className={
                  person.isActive
                    ? "member-status active"
                    : "member-status inactive"
                }
              >
                {person.isActive ? "Active" : "Inactive"}
              </span>
            </dd>
          </div>
          <div>
            <dt>Last attendance</dt>
            <dd>{formatDate(lastAttendanceDate)}</dd>
          </div>
          {!person.isActive && (
            <div>
              <dt>Date made inactive</dt>
              <dd>{formatDate(person.inactiveAt)}</dd>
            </div>
          )}
        </dl>
        {canManageLifecycle && (
          <div className="member-history">
            <h3>History</h3>
            <AuditHistory relatedEntityId={person.id} compact />
          </div>
        )}
        <div className="modal-actions">
          <button className="button subtle" type="button" onClick={onEdit}>
            Edit details
          </button>
          {!person.isActive && canManageLifecycle && (
            <button
              className="button primary"
              type="button"
              onClick={onReactivate}
            >
              Reactivate member
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
