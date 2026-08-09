"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Archive, CheckSquare2, RotateCcw, X } from "lucide-react";
import { useAuth } from "@/components/auth/AuthProvider";
import { AuditHistory } from "@/components/audit/AuditHistory";
import { BulkMemberEntryModal } from "@/components/people/BulkMemberEntryModal";
import { MemberAttendanceHistory } from "@/components/people/MemberAttendanceHistory";
import { MemberMergeModal } from "@/components/people/MemberMergeModal";
import { useToast } from "@/components/feedback/ToastProvider";
import { useConfirmation } from "@/components/feedback/ConfirmationProvider";
import { EmptyState } from "@/components/feedback/EmptyState";
import { isAdmin } from "@/lib/auth/permissions";
import type { Person } from "@/lib/domain";
import { formatDate } from "@/lib/format/date-time";
import {
  DEFAULT_MEMBER_DIRECTORY_VIEW,
  filterDirectoryMembers,
  sortDirectoryMembers,
  type MemberDirectorySort,
  type MemberDirectoryView,
} from "@/lib/people/member-directory";
import { findLikelyMemberMatches } from "@/lib/people/member-matching";
import {
  bulkUpdateMemberLifecycle,
  type BulkMemberLifecycleAction,
  type BulkMemberLifecycleResult,
} from "@/lib/people/bulk-member-management";
import {
  findExactMemberMatches,
  getLastAttendanceDates,
  getMemberAttendanceCounts,
  getMemberPrivateDetails,
  listActiveMembers,
  listMemberCandidates,
  listMembers,
  markMemberInactive,
  removeMember,
  restoreMember,
  saveMember,
  saveMemberPrivateDetails,
} from "@/lib/repositories/attendance-repository";
import { subscribeToDataChanges } from "@/lib/storage/data-events";
import { useEscapeKey } from "@/lib/ui/keyboard";

interface FormState {
  id?: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  notes: string;
}

const emptyForm: FormState = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  notes: "",
};

export function PeopleDirectory() {
  const { user } = useAuth();
  const { showToast } = useToast();
  const confirmAction = useConfirmation();
  const [people, setPeople] = useState<Person[]>([]);
  const [memberCandidates, setMemberCandidates] = useState<Person[]>([]);
  const [lastAttendance, setLastAttendance] = useState<Map<string, string>>(
    new Map(),
  );
  const [attendanceCounts, setAttendanceCounts] = useState<Map<string, number>>(
    new Map(),
  );
  const [query, setQuery] = useState("");
  const [view, setView] = useState<MemberDirectoryView>(
    DEFAULT_MEMBER_DIRECTORY_VIEW,
  );
  const [form, setForm] = useState<FormState | null>(null);
  const [profile, setProfile] = useState<Person | null>(null);
  const [profileNotes, setProfileNotes] = useState("");
  const [reactivateTarget, setReactivateTarget] = useState<Person | null>(null);
  const [duplicate, setDuplicate] = useState<Person | null>(null);
  const [multipleMatches, setMultipleMatches] = useState<Person[]>([]);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [sort, setSort] = useState<MemberDirectorySort>("name");
  const [saving, setSaving] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkProcessing, setBulkProcessing] = useState(false);
  const bulkProcessingRef = useRef(false);
  const bulkSubmissionRef = useRef(false);
  const [bulkConfirming, setBulkConfirming] = useState(false);
  const [bulkResult, setBulkResult] =
    useState<BulkMemberLifecycleResult | null>(null);

  const admin = isAdmin(user);

  const refresh = useCallback(async () => {
    if (!user) return;
    const [members, candidates, dates, counts] = await Promise.all([
      admin
        ? listMembers(user.organizationId)
        : listActiveMembers(user.organizationId),
      listMemberCandidates(user.organizationId),
      getLastAttendanceDates(user.organizationId),
      getMemberAttendanceCounts(user.organizationId),
    ]);
    setPeople(members);
    setMemberCandidates(candidates);
    setLastAttendance(dates);
    setAttendanceCounts(counts);
    setProfile((current) =>
      current ? members.find((member) => member.id === current.id) ?? null : null,
    );
  }, [admin, user]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    const unsubscribe = subscribeToDataChanges(() => {
      if (!bulkProcessingRef.current) void refresh();
    });
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [refresh]);

  const effectiveView =
    !admin && (view === "inactive" || view === "all") ? "active" : view;
  const filtered = useMemo(
    () =>
      sortDirectoryMembers(
        filterDirectoryMembers(people, effectiveView, query),
        sort,
        lastAttendance,
        attendanceCounts,
      ),
    [attendanceCounts, effectiveView, lastAttendance, people, query, sort],
  );
  const likelyMatches = useMemo(
    () =>
      form && !form.id && user
        ? findLikelyMemberMatches(
            memberCandidates,
            `${form.firstName} ${form.lastName}`,
            user.organizationId,
          ).slice(0, 5)
        : [],
    [form, memberCandidates, user],
  );

  const inactiveCount = people.filter((person) => !person.isActive).length;
  const visibleIds = useMemo(
    () => filtered.map((person) => person.id),
    [filtered],
  );
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));

  useEffect(() => {
    if (!admin || !selectionMode) return;
    const handleSelectAll = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "a") {
        return;
      }
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      setSelectedIds((current) => {
        const next = new Set(current);
        visibleIds.forEach((id) => next.add(id));
        return next;
      });
    };
    window.addEventListener("keydown", handleSelectAll);
    return () => window.removeEventListener("keydown", handleSelectAll);
  }, [admin, selectionMode, visibleIds]);

  useEscapeKey(
    () => {
      if (mergeOpen) {
        setMergeOpen(false);
      } else if (form) {
        setDuplicate(null);
        setForm(null);
      } else if (multipleMatches.length > 0) {
        setMultipleMatches([]);
      } else if (reactivateTarget) {
        setReactivateTarget(null);
      } else if (profile) {
        setProfile(null);
      } else if (selectionMode) {
        setSelectionMode(false);
        setSelectedIds(new Set());
      }
    },
    Boolean(
      mergeOpen ||
        form ||
        multipleMatches.length ||
        reactivateTarget ||
        profile ||
        selectionMode,
    ),
  );

  function exitSelectionMode() {
    if (bulkProcessing || bulkConfirming) return;
    setSelectionMode(false);
    setSelectedIds(new Set());
  }

  function toggleSelected(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllVisible() {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (allVisibleSelected) visibleIds.forEach((id) => next.delete(id));
      else visibleIds.forEach((id) => next.add(id));
      return next;
    });
  }

  async function runBulkAction(action: BulkMemberLifecycleAction) {
    if (
      !user ||
      !admin ||
      bulkSubmissionRef.current ||
      selectedIds.size === 0
    ) {
      return;
    }
    bulkSubmissionRef.current = true;
    setBulkConfirming(true);
    const verb = action === "archive" ? "Archive" : "Restore";
    const approved = await confirmAction({
      title: `${verb} ${selectedIds.size} selected ${
        selectedIds.size === 1 ? "member" : "members"
      }?`,
      message:
        action === "archive"
          ? "Selected active members will leave attendance lists. Their history, notes, UUIDs, and relationships will be preserved."
          : "Selected inactive members will return to the active directory and attendance lists. Existing history and relationships will remain attached.",
      confirmLabel: `${verb} selected`,
      tone: action === "archive" ? "danger" : "default",
    });
    if (!approved) {
      bulkSubmissionRef.current = false;
      setBulkConfirming(false);
      return;
    }

    setBulkConfirming(false);
    bulkProcessingRef.current = true;
    setBulkProcessing(true);
    setBulkResult(null);
    try {
      const result = await bulkUpdateMemberLifecycle(user, selectedIds, action);
      setBulkResult(result);
      const summary = `Updated ${result.updated}. Skipped ${result.skipped}. Failed ${result.failed.length}.`;
      showToast(summary, {
        key: `bulk-members:${action}:${[...selectedIds].sort().join(",")}`,
        tone: result.failed.length > 0 ? "error" : "success",
      });
      if (result.failed.length > 0) {
        setSelectedIds(new Set(result.failed.map((failure) => failure.id)));
      } else {
        setSelectionMode(false);
        setSelectedIds(new Set());
      }
      await refresh();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "The bulk action could not be completed.";
      setBulkResult({
        action,
        requested: selectedIds.size,
        updated: 0,
        skipped: 0,
        failed: [{ id: "bulk-action", name: "Selected members", message }],
        updatedIds: [],
        skippedIds: [],
      });
      showToast(message, { key: `bulk-members:${action}:error`, tone: "error" });
    } finally {
      bulkSubmissionRef.current = false;
      bulkProcessingRef.current = false;
      setBulkProcessing(false);
    }
  }

  async function submit(
    event: Pick<FormEvent, "preventDefault">,
    allowDuplicate = false,
  ) {
    event.preventDefault();
    if (!form || !user) return;
    if (!form.id && !allowDuplicate) {
      const exactMatches = await findExactMemberMatches(
        user.organizationId,
        `${form.firstName} ${form.lastName}`,
      );
      const normalizedMatches = findLikelyMemberMatches(
        memberCandidates,
        `${form.firstName} ${form.lastName}`,
        user.organizationId,
      )
        .filter((match) => match.reason !== "similar")
        .map((match) => match.person);
      const matches = [
        ...new Map(
          [...exactMatches, ...normalizedMatches].map((person) => [
            person.id,
            person,
          ]),
        ).values(),
      ];
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
    const saved = await saveMember(user, { ...form, allowDuplicate });
    if (isAdmin(user)) {
      await saveMemberPrivateDetails(user, saved.id, form.notes);
    }
    setSaving(false);
    setForm(null);
    setDuplicate(null);
    await refresh();
    showToast(form.id ? "Member updated." : "Member added.", {
      key: `member-saved:${saved.id}:${saved.updatedAt}`,
    });
  }

  async function deactivate(person: Person) {
    if (
      !user ||
      !(await confirmAction({
        title: `Make ${person.displayName} inactive?`,
        message:
          "They will leave active attendance lists, but their history will remain available.",
        confirmLabel: "Make inactive",
        tone: "danger",
      }))
    ) {
      return;
    }
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
      !(await confirmAction({
        title: `Remove ${person.displayName}?`,
        message:
          "The member will be removed from the directory. Their historical attendance will remain preserved.",
        confirmLabel: "Remove member",
        tone: "danger",
      }))
    ) {
      return;
    }
    await removeMember(user, person.id);
    setProfile(null);
    await refresh();
  }

  async function edit(person: Person) {
    if (!user) return;
    const details = await getMemberPrivateDetails(user, person.id);
    setProfile(null);
    setForm({
      id: person.id,
      firstName: person.firstName,
      lastName: person.lastName,
      email: person.email ?? "",
      phone: person.phone ?? "",
      notes: details?.notes ?? "",
    });
  }

  async function viewProfile(person: Person) {
    if (!user) return;
    const details = await getMemberPrivateDetails(user, person.id);
    setProfileNotes(details?.notes ?? "");
    setProfile(person);
  }

  return (
    <div className="page-stack product-page people-page">
      <div className="page-heading with-action">
        <div>
          <p className="eyebrow">Directory</p>
          <h1>People</h1>
          <p>Active members appear automatically when you record a service.</p>
        </div>
        <div className="people-page-actions">
          <div className="button-row people-management-actions">
          {admin && (
            <button
              className={selectionMode ? "button secondary" : "button subtle"}
              type="button"
              aria-pressed={selectionMode}
              onClick={() => {
                if (selectionMode) exitSelectionMode();
                else {
                  setSelectionMode(true);
                  setBulkResult(null);
                }
              }}
            >
              <CheckSquare2 aria-hidden="true" />
              {selectionMode ? "Exit selection" : "Select"}
            </button>
          )}
          {admin && (
            <button
              className="button subtle"
              type="button"
              onClick={() => setMergeOpen(true)}
            >
              Merge Members
            </button>
          )}
          </div>
          <div className="button-row people-create-actions">
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
      </div>

      <section className="people-directory-workspace" aria-label="Member directory">
        <div
          className="member-filter-tabs"
          role="tablist"
          aria-label="Filter church members"
        >
          {(
            [
              ["active", "Active Members"],
              ["recently_added", "Recently Added"],
              ["recently_restored", "Recently Restored"],
              ...(admin
                ? ([
                    ["inactive", `Inactive Members (${inactiveCount})`],
                    ["all", "All Members"],
                  ] as const)
                : []),
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

        <div className="panel-toolbar">
          <label className="search-field">
            <span className="sr-only">Search {effectiveView} members</span>
            <span aria-hidden="true">⌕</span>
            <input
              type="search"
              placeholder="Search names, email, phone, or status"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <label className="member-sort-control">
            <span>Sort by</span>
            <select
              value={sort}
              onChange={(event) =>
                setSort(event.target.value as MemberDirectorySort)
              }
            >
              <option value="name">Name</option>
              <option value="date_added">Date added</option>
              <option value="last_attendance">Last attendance</option>
              <option value="attendance_count">Attendance count</option>
            </select>
          </label>
          {selectionMode && admin && (
            <button
              className="button subtle select-visible-members"
              type="button"
              aria-pressed={allVisibleSelected}
              disabled={visibleIds.length === 0 || bulkProcessing || bulkConfirming}
              onClick={toggleAllVisible}
            >
              <CheckSquare2 aria-hidden="true" />
              {allVisibleSelected ? "Deselect visible" : "Select all visible"}
            </button>
          )}
          <span className="count-label">
            {filtered.length}{" "}
            {effectiveView === "all" ? "total" : effectiveView} members
          </span>
        </div>

        <div className="person-list">
          {filtered.map((person) => (
            <article
              className={`person-row ${person.isActive ? "" : "inactive"} ${
                selectedIds.has(person.id) ? "selected" : ""
              }`}
              key={person.id}
            >
              {selectionMode && admin && (
                <label className="member-selection-checkbox">
                  <input
                    type="checkbox"
                    checked={selectedIds.has(person.id)}
                    disabled={bulkProcessing || bulkConfirming}
                    onChange={() => toggleSelected(person.id)}
                    aria-label={`Select ${person.displayName}`}
                  />
                  <span aria-hidden="true" />
                </label>
              )}
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
                  <span>
                    {attendanceCounts.get(person.id) ?? 0} services attended
                  </span>
                </span>
              </div>
              <div className="row-actions member-row-actions">
                <div className="routine-actions">
                <button
                  className="button subtle"
                  type="button"
                  onClick={() => void viewProfile(person)}
                >
                  View profile
                </button>
                <button
                  className="button subtle"
                  type="button"
                  onClick={() => void edit(person)}
                >
                  Edit
                </button>
                </div>
                {admin &&
                  (person.isActive ? (
                    <div className="destructive-actions">
                    <button
                      className="button danger-text"
                      type="button"
                      onClick={() => void deactivate(person)}
                    >
                      Make inactive
                    </button>
                    </div>
                  ) : (
                    <div className="lifecycle-actions">
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
                    </div>
                  ))}
              </div>
            </article>
          ))}
          {!filtered.length && (
            <EmptyState
              compact
              icon={query ? "⌕" : "+"}
              title={
                effectiveView === "inactive"
                  ? "No inactive members"
                  : "No members found"
              }
              message={
                query
                  ? "Try another name or clear the search."
                  : effectiveView === "inactive"
                    ? "Members made inactive will appear here."
                    : "Add your first member to begin taking attendance."
              }
            />
          )}
        </div>
        {bulkResult && (
          <div
            className={`notice ${bulkResult.failed.length > 0 ? "warning" : "success"}`}
            role="status"
          >
            <strong>
              {bulkResult.action === "archive" ? "Archive" : "Restore"} complete
            </strong>
            <span>
              Updated {bulkResult.updated}. Skipped {bulkResult.skipped}. Failed{" "}
              {bulkResult.failed.length}.
            </span>
            {bulkResult.failed.length > 0 && (
              <ul>
                {bulkResult.failed.map((failure) => (
                  <li key={failure.id}>
                    {failure.name}: {failure.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      {admin && selectionMode && selectedIds.size > 0 && (
        <div
          className="bulk-member-toolbar"
          role="toolbar"
          aria-label="Bulk member actions"
          aria-busy={bulkProcessing || bulkConfirming}
        >
          <strong>{selectedIds.size} selected</strong>
          <span className="bulk-member-toolbar-divider" aria-hidden="true" />
          <button
            className="button danger-text"
            type="button"
            disabled={bulkProcessing || bulkConfirming}
            onClick={() => void runBulkAction("archive")}
          >
            <Archive aria-hidden="true" /> Archive selected
          </button>
          <button
            className="button subtle"
            type="button"
            disabled={bulkProcessing || bulkConfirming}
            onClick={() => void runBulkAction("restore")}
          >
            <RotateCcw aria-hidden="true" /> Restore selected
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label="Cancel member selection"
            disabled={bulkProcessing || bulkConfirming}
            onClick={exitSelectionMode}
          >
            <X aria-hidden="true" />
          </button>
          {bulkProcessing && <span className="sr-only">Processing selected members</span>}
        </div>
      )}

      {profile && (
        <MemberProfileModal
          person={profile}
          lastAttendanceDate={lastAttendance.get(profile.id)}
          canManageLifecycle={admin}
          notes={profileNotes}
          onClose={() => setProfile(null)}
          onEdit={() => void edit(profile)}
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
                        void viewProfile(match);
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
              <div className="form-grid">
                <label>
                  Email address <span className="optional">(optional)</span>
                  <input
                    type="email"
                    autoComplete="email"
                    maxLength={254}
                    value={form.email}
                    onChange={(event) =>
                      setForm({ ...form, email: event.target.value })
                    }
                  />
                </label>
                <label>
                  Phone number <span className="optional">(optional)</span>
                  <input
                    type="tel"
                    autoComplete="tel"
                    maxLength={50}
                    value={form.phone}
                    onChange={(event) =>
                      setForm({ ...form, phone: event.target.value })
                    }
                  />
                </label>
              </div>
              {admin && (
                <label>
                  Administrative notes{" "}
                  <span className="optional">(optional, Admin only)</span>
                  <textarea
                    maxLength={4000}
                    value={form.notes}
                    onChange={(event) =>
                      setForm({ ...form, notes: event.target.value })
                    }
                    placeholder="Plain-text notes for church administration"
                  />
                </label>
              )}
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
                      void viewProfile(duplicate);
                      setDuplicate(null);
                    }}
                  >
                    Open existing member
                  </button>
                </div>
              )}
              {!form.id && likelyMatches.length > 0 && !duplicate && (
                <div className="member-suggestions" role="status">
                  <strong>Possible existing members</strong>
                  <span>Check these records before creating a new person.</span>
                  {likelyMatches.map(({ person, reason }) => (
                    <button
                      className="button subtle"
                      type="button"
                      key={person.id}
                      onClick={() => {
                        setForm(null);
                        if (person.isActive && !person.deletedAt) {
                          void viewProfile(person);
                        } else {
                          setReactivateTarget(person);
                        }
                      }}
                    >
                      {person.displayName} ·{" "}
                      {reason === "exact"
                        ? "Exact match"
                        : reason === "punctuation"
                          ? "Same normalized name"
                          : "Similar spelling"}
                    </button>
                  ))}
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
      {mergeOpen && admin && (
        <MemberMergeModal
          members={memberCandidates}
          onClose={() => setMergeOpen(false)}
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
  notes,
  onClose,
  onEdit,
  onReactivate,
}: {
  person: Person;
  lastAttendanceDate?: string;
  canManageLifecycle: boolean;
  notes: string;
  onClose: () => void;
  onEdit: () => void;
  onReactivate: () => void;
}) {
  const [activeTab, setActiveTab] = useState<"profile" | "attendance">(
    "profile",
  );

  function selectTab(next: "profile" | "attendance") {
    setActiveTab(next);
    window.requestAnimationFrame(() =>
      document.getElementById(`member-${next}-tab`)?.focus(),
    );
  }

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
        <div
          className="member-profile-tabs"
          role="tablist"
          aria-label={`${person.displayName} profile sections`}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
              event.preventDefault();
              selectTab(activeTab === "profile" ? "attendance" : "profile");
            }
          }}
        >
          <button
            id="member-profile-tab"
            type="button"
            role="tab"
            aria-selected={activeTab === "profile"}
            aria-controls="member-profile-panel"
            tabIndex={activeTab === "profile" ? 0 : -1}
            onClick={() => setActiveTab("profile")}
          >
            Profile
          </button>
          <button
            id="member-attendance-tab"
            type="button"
            role="tab"
            aria-selected={activeTab === "attendance"}
            aria-controls="member-attendance-panel"
            tabIndex={activeTab === "attendance" ? 0 : -1}
            onClick={() => setActiveTab("attendance")}
          >
            Attendance History
          </button>
        </div>
        {activeTab === "profile" && (
          <div
            id="member-profile-panel"
            role="tabpanel"
            aria-labelledby="member-profile-tab"
          >
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
              {person.email && (
                <div>
                  <dt>Email</dt>
                  <dd>
                    <a href={`mailto:${person.email}`}>{person.email}</a>
                  </dd>
                </div>
              )}
              {person.phone && (
                <div>
                  <dt>Phone</dt>
                  <dd>
                    <a href={`tel:${person.phone}`}>{person.phone}</a>
                  </dd>
                </div>
              )}
              {canManageLifecycle && notes && (
                <div className="member-profile-notes">
                  <dt>Administrative notes</dt>
                  <dd>{notes}</dd>
                </div>
              )}
            </dl>
            {canManageLifecycle && (
              <div className="member-history">
                <h3>Member activity</h3>
                <AuditHistory
                  relatedEntityId={person.id}
                  relatedEntityIds={person.mergedFromIds}
                  compact
                />
              </div>
            )}
          </div>
        )}
        {activeTab === "attendance" && (
          <div
            id="member-attendance-panel"
            role="tabpanel"
            aria-labelledby="member-attendance-tab"
          >
            <MemberAttendanceHistory
              organizationId={person.organizationId}
              personId={person.id}
              memberName={person.displayName}
            />
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
