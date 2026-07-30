"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { useSynchronization } from "@/components/sync/SyncProvider";
import { AuditHistory } from "@/components/audit/AuditHistory";
import { recordAuditEntry } from "@/lib/audit/audit-repository";
import {
  SERVICE_TYPES,
  DEFAULT_APPLICATION_SETTINGS,
  type ApplicationSettings,
  type ChurchService,
  type Person,
  type ServiceType,
  type ServiceVisitor,
  type SyncQueueItem,
} from "@/lib/domain";
import {
  addServiceVisitor,
  adjustUnnamedVisitorCount,
  editServiceVisitor,
  findExactMemberMatches,
  getLastAttendanceDates,
  getServiceAttendance,
  listActiveMembers,
  listMembers,
  listServiceVisitors,
  removeServiceVisitor,
  removeService,
  saveService,
  saveMember,
  setServiceArchived,
  setMemberAttendance,
  restoreMember,
} from "@/lib/repositories/attendance-repository";
import { subscribeToDataChanges } from "@/lib/storage/data-events";
import { isAdmin } from "@/lib/auth/permissions";
import { serviceSaveFeedback } from "@/lib/services/save-feedback";
import { getOrganizationSettings } from "@/lib/repositories/settings-repository";
import {
  formatChurchDate,
  sortAttendanceMembers,
} from "@/lib/settings/settings";
import {
  attendanceCounts,
  attendancePresentCounts,
  filterAttendanceMembers,
  filterAttendanceVisitors,
  type AttendanceFilter,
} from "@/lib/services/attendance-view";
import {
  filterServiceDirectory,
  groupServiceDirectory,
  loadOrganizationServiceDirectory,
  type ServiceDirectoryFilter,
  type ServiceDirectoryItem,
} from "@/lib/services/service-directory";
import {
  listVisitorConflicts,
  resolveVisitorConflict,
} from "@/lib/sync/visitor-conflicts";
import { getPendingChanges } from "@/lib/sync/queue";

type AttendanceTab = "members" | "visitors" | "history";

function localDate(timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function serviceTitle(service: ChurchService) {
  return service.customName || service.serviceType;
}

function displayServiceTime(value: string) {
  const [hours, minutes] = value.split(":").map(Number);
  return new Date(2026, 0, 1, hours, minutes).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function storedFolderKeys(value: string | null, fallback: string[]) {
  if (!value) return fallback;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : fallback;
  } catch {
    return fallback;
  }
}

export function ServiceManager() {
  const { user } = useAuth();
  const { syncNow } = useSynchronization();
  const [services, setServices] = useState<ChurchService[]>([]);
  const [serviceDirectory, setServiceDirectory] = useState<
    ServiceDirectoryItem[]
  >([]);
  const [members, setMembers] = useState<Person[]>([]);
  const [settings, setSettings] = useState<ApplicationSettings>(
    DEFAULT_APPLICATION_SETTINGS,
  );
  const [active, setActive] = useState<ChurchService | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [visitors, setVisitors] = useState<ServiceVisitor[]>([]);
  const [memberSearch, setMemberSearch] = useState("");
  const [visitorSearch, setVisitorSearch] = useState("");
  const [attendanceTab, setAttendanceTab] =
    useState<AttendanceTab>("members");
  const [attendanceFilter, setAttendanceFilter] =
    useState<AttendanceFilter>("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [visitorOpen, setVisitorOpen] = useState(false);
  const [memberOpen, setMemberOpen] = useState(false);
  const [editingVisitor, setEditingVisitor] =
    useState<ServiceVisitor | null>(null);
  const [historyVisitor, setHistoryVisitor] =
    useState<ServiceVisitor | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [serviceAction, setServiceAction] = useState<
    "draft" | "completed" | null
  >(null);
  const [actionFeedback, setActionFeedback] = useState("");
  const [visitorConflicts, setVisitorConflicts] = useState<SyncQueueItem[]>([]);
  const [reviewingConflict, setReviewingConflict] =
    useState<SyncQueueItem | null>(null);
  const [serviceSearch, setServiceSearch] = useState("");
  const [serviceFilter, setServiceFilter] =
    useState<ServiceDirectoryFilter>("all");
  const [expandedYears, setExpandedYears] = useState<Set<string>>(new Set());
  const [expandedMonths, setExpandedMonths] = useState<Set<string>>(new Set());
  const [pendingRecordKeys, setPendingRecordKeys] = useState<Set<string>>(
    new Set(),
  );
  const [recentMemberId, setRecentMemberId] = useState("");
  const [recentVisitorId, setRecentVisitorId] = useState("");
  const handledDashboardIntent = useRef("");
  const initializedServiceFolders = useRef("");
  const selectedRef = useRef<Set<string>>(new Set());
  const activeRef = useRef<ChurchService | null>(null);
  const tabScrollPositions = useRef<Record<AttendanceTab, number>>({
    members: 0,
    visitors: 0,
    history: 0,
  });
  const memberTabRef = useRef<HTMLButtonElement>(null);
  const visitorTabRef = useRef<HTMLButtonElement>(null);
  const historyTabRef = useRef<HTMLButtonElement>(null);

  const refreshLists = useCallback(async () => {
    if (!user) return;
    const [directory, settingsRecord, conflicts, pending] = await Promise.all([
      loadOrganizationServiceDirectory(user.organizationId),
      getOrganizationSettings(user.organizationId),
      listVisitorConflicts(user.organizationId),
      getPendingChanges(user.organizationId),
    ]);
    const nextMembers = settingsRecord.settings.showInactiveInAttendance
      ? await listMembers(user.organizationId)
      : await listActiveMembers(user.organizationId);
    setServiceDirectory(directory);
    setServices(directory.map((item) => item.service));
    setMembers(nextMembers);
    setSettings(settingsRecord.settings);
    setVisitorConflicts(conflicts);
    setPendingRecordKeys(
      new Set(pending.map((item) => `${item.table}:${item.recordId}`)),
    );
    return directory;
  }, [user]);

  const openService = useCallback(
    async (
      service: ChurchService,
      options: { resetView?: boolean } = {},
    ) => {
      const [attendance, nextVisitors] = await Promise.all([
        getServiceAttendance(service.id),
        listServiceVisitors(service.id),
      ]);
      activeRef.current = service;
      setActive(service);
      const nextSelected = new Set(
        attendance.filter((item) => item.present).map((item) => item.personId),
      );
      selectedRef.current = nextSelected;
      setSelected(nextSelected);
      setVisitors(nextVisitors);
      if (options.resetView !== false) {
        setMemberSearch("");
        setVisitorSearch("");
        setAttendanceFilter("all");
        setAttendanceTab("members");
      }
    },
    [],
  );

  useEffect(() => {
    const refresh = () => {
      void refreshLists().then((directory) => {
        if (!directory || !activeRef.current) return;
        const current = directory.find(
          (item) => item.service.id === activeRef.current?.id,
        )?.service;
        if (current) void openService(current, { resetView: false });
      });
    };
    const timer = window.setTimeout(refresh, 0);
    const unsubscribe = subscribeToDataChanges(refresh);
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [openService, refreshLists]);

  useEffect(() => {
    const query = window.location.search;
    if (!query || handledDashboardIntent.current === query) return;
    const parameters = new URLSearchParams(query);
    if (parameters.get("new") === "1") {
      handledDashboardIntent.current = query;
      setCreateOpen(true);
      return;
    }
    const serviceId = parameters.get("service");
    const requestedService = services.find(
      (service) => service.id === serviceId,
    );
    if (!requestedService) return;
    handledDashboardIntent.current = query;
    void openService(requestedService).then(() => {
      if (parameters.get("visitor") === "1") {
        setAttendanceTab("visitors");
        setVisitorOpen(true);
      }
    });
  }, [openService, services]);

  useEffect(() => {
    if (!recentMemberId && !recentVisitorId) return;
    const timer = window.setTimeout(() => {
      setRecentMemberId("");
      setRecentVisitorId("");
    }, 1800);
    return () => window.clearTimeout(timer);
  }, [recentMemberId, recentVisitorId]);

  async function toggleMember(personId: string) {
    if (!user || !active || active.status === "completed") return;
    const present = !selectedRef.current.has(personId);
    const next = new Set(selectedRef.current);
    if (present) next.add(personId);
    else next.delete(personId);
    selectedRef.current = next;
    setSelected(next);
    await setMemberAttendance(user, active.id, personId, present);
  }

  async function markAllAbsent() {
    if (
      !user ||
      !active ||
      active.status === "completed" ||
      selectedRef.current.size === 0
    ) {
      return;
    }
    if (
      !confirm(
        "Mark all members absent? This will clear every Present selection.",
      )
    ) {
      return;
    }
    const previouslySelected = [...selectedRef.current];
    selectedRef.current = new Set();
    setSelected(new Set());
    await Promise.all(
      previouslySelected.map((personId) =>
        setMemberAttendance(user, active.id, personId, false),
      ),
    );
    await recordAuditEntry(user, {
      entityType: "attendance",
      entityId: active.id,
      action: "attendance_cleared",
      details: {
        serviceId: active.id,
        count: previouslySelected.length,
      },
    });
  }

  async function setStatus(status: "draft" | "completed") {
    if (!user || !active || serviceAction) return;
    if (status === "draft" && active.status === "completed") {
      if (!isAdmin(user) || !settings.allowAdminReopenCompleted) return;
      if (!confirm("Reopen this completed service for editing?")) return;
    }
    if (status === "completed") {
      const zeroWarning =
        settings.warnZeroAttendance && presentCounts.total === 0
          ? " No attendance has been recorded."
          : "";
      if (
        (settings.confirmComplete || zeroWarning) &&
        !confirm(`Finish this service?${zeroWarning}`)
      ) {
        return;
      }
    }
    setServiceAction(status);
    setActionFeedback("");
    try {
      if (status === "completed" && navigator.onLine) {
        await syncNow();
        const conflicts = await listVisitorConflicts(
          user.organizationId,
          active.id,
        );
        setVisitorConflicts((current) => [
          ...current.filter(
            (item) => item.conflict?.serviceId !== active.id,
          ),
          ...conflicts,
        ]);
        if (conflicts.length > 0) return;
      }
      const updated = await saveService(user, { ...active, status });
      activeRef.current = updated;
      setActive(updated);
      await refreshLists();
      const outcome = await syncNow();
      setActionFeedback(serviceSaveFeedback(status, outcome.status));
    } finally {
      setServiceAction(null);
    }
  }

  const filteredMembers = useMemo(() => {
    return filterAttendanceMembers(
      sortAttendanceMembers(members, settings.attendanceSort),
      selected,
      attendanceFilter,
      memberSearch,
    );
  }, [
    attendanceFilter,
    memberSearch,
    members,
    selected,
    settings.attendanceSort,
  ]);

  const memberCounts = useMemo(
    () => attendanceCounts(members, selected),
    [members, selected],
  );

  const presentCounts = useMemo(
    () =>
      attendancePresentCounts(
        selected,
        visitors,
        settings.includeVisitorsInTotal,
        active?.unnamedVisitorCount ?? 0,
      ),
    [
      active?.unnamedVisitorCount,
      selected,
      settings.includeVisitorsInTotal,
      visitors,
    ],
  );

  const filteredVisitors = useMemo(
    () => filterAttendanceVisitors(visitors, "all", visitorSearch),
    [visitorSearch, visitors],
  );

  function selectAttendanceTab(tab: AttendanceTab, focus = false) {
    if (tab === attendanceTab) return;
    tabScrollPositions.current[attendanceTab] = window.scrollY;
    setAttendanceTab(tab);
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: tabScrollPositions.current[tab] });
      if (focus) {
        (
          tab === "members"
            ? memberTabRef
            : tab === "visitors"
              ? visitorTabRef
              : historyTabRef
        ).current?.focus();
      }
    });
  }

  async function changeUnnamedVisitorCount(change: number) {
    if (!user || !active || active.status === "completed") return;
    const updated = await adjustUnnamedVisitorCount(user, active.id, change);
    activeRef.current = updated;
    setActive(updated);
    await refreshLists();
  }

  function highlightCard(id: string) {
    window.setTimeout(() => {
      document.getElementById(id)?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }, 50);
  }

  async function createQuickMember(
    firstName: string,
    lastName: string,
  ) {
    if (!user || !active || active.status === "completed") return undefined;
    const matches = await findExactMemberMatches(
      user.organizationId,
      `${firstName} ${lastName}`,
    );
    if (matches.length > 0) {
      const lastAttendance = await getLastAttendanceDates(user.organizationId);
      return matches.map((person) => ({
        person,
        lastAttendanceDate: lastAttendance.get(person.id),
      }));
    }
    const member = await saveMember(user, {
      firstName,
      lastName,
    });
    await setMemberAttendance(user, active.id, member.id, true);
    setAttendanceTab("members");
    setRecentMemberId(member.id);
    await refreshLists();
    await openService(active, { resetView: false });
    highlightCard(`member-card-${member.id}`);
    return undefined;
  }

  async function useExistingQuickMember(person: Person) {
    if (!user || !active || active.status === "completed") return;
    if (!person.isActive) {
      await restoreMember(user, person.id);
    }
    await setMemberAttendance(user, active.id, person.id, true);
    setAttendanceTab("members");
    setRecentMemberId(person.id);
    await refreshLists();
    await openService(active, { resetView: false });
    highlightCard(`member-card-${person.id}`);
  }

  const visibleServiceDirectory = useMemo(
    () =>
      filterServiceDirectory(
        serviceDirectory,
        serviceFilter,
        serviceSearch,
      ),
    [serviceDirectory, serviceFilter, serviceSearch],
  );
  const serviceGroups = useMemo(
    () => groupServiceDirectory(visibleServiceDirectory),
    [visibleServiceDirectory],
  );

  useEffect(() => {
    if (!user || serviceGroups.length === 0) return;
    const initializationKey = `${user.organizationId}:${serviceGroups[0].year}`;
    if (initializedServiceFolders.current === initializationKey) return;
    initializedServiceFolders.current = initializationKey;
    const current = localDate(settings.timezone).slice(0, 7);
    const storedYears = window.localStorage.getItem(
      `service-folders:${user.organizationId}:years`,
    );
    const storedMonths = window.localStorage.getItem(
      `service-folders:${user.organizationId}:months`,
    );
    setExpandedYears(
      new Set(
        storedFolderKeys(storedYears, [
          serviceGroups.some((group) => group.year === current.slice(0, 4))
            ? current.slice(0, 4)
            : serviceGroups[0].year,
        ]),
      ),
    );
    setExpandedMonths(
      new Set(
        storedFolderKeys(
          storedMonths,
          serviceGroups.some((group) =>
            group.months.some((month) => month.key === current),
          )
            ? [current]
            : [serviceGroups[0].months[0].key],
        ),
      ),
    );
  }, [serviceGroups, settings.timezone, user]);

  function toggleFolder(
    type: "years" | "months",
    key: string,
    open: boolean,
  ) {
    if (!user) return;
    const setter = type === "years" ? setExpandedYears : setExpandedMonths;
    setter((current) => {
      const next = new Set(current);
      if (open) next.add(key);
      else next.delete(key);
      window.localStorage.setItem(
        `service-folders:${user.organizationId}:${type}`,
        JSON.stringify([...next]),
      );
      return next;
    });
  }

  const activeVisitorConflicts = active
    ? visitorConflicts.filter(
        (item) => item.conflict?.serviceId === active.id,
      )
    : [];
  if (active) {
    const serviceLocked = active.status === "completed";
    return (
      <div
        className={
          serviceLocked
            ? "attendance-workspace completed-service-locked"
            : "attendance-workspace"
        }
      >
        <div className="service-topline attendance-service-header">
          <button
            className="button subtle"
            type="button"
            onClick={() => {
              activeRef.current = null;
              setActive(null);
            }}
          >
            ← All services
          </button>
          <div className="service-admin-actions">
            <span className={`status-pill ${active.status}`}>{active.status}</span>
            {active.status === "completed" ? (
              isAdmin(user) &&
              settings.allowAdminReopenCompleted && (
                <button
                  className="button secondary"
                  type="button"
                  disabled={serviceAction !== null}
                  onClick={() => void setStatus("draft")}
                >
                  {serviceAction === "draft" ? "Saving…" : "Reopen Service"}
                </button>
              )
            ) : (
              <>
                <button
                  className="button secondary"
                  type="button"
                  disabled={serviceAction !== null}
                  onClick={() => void setStatus("draft")}
                >
                  {serviceAction === "draft" ? "Saving…" : "Save Draft"}
                </button>
                <button
                  className="button primary"
                  type="button"
                  disabled={serviceAction !== null}
                  onClick={() => void setStatus("completed")}
                >
                  {serviceAction === "completed" ? "Saving…" : "Finish Service"}
                </button>
              </>
            )}
            {isAdmin(user) && (
              <>
                <button
                  className="button subtle"
                  type="button"
                  disabled={serviceLocked}
                  title={
                    serviceLocked
                      ? "Reopen this service before editing its details."
                      : undefined
                  }
                  onClick={() => setEditOpen(true)}
                >
                  Edit
                </button>
                <button
                  className="button danger-text"
                  type="button"
                  onClick={() => {
                    if (!user) return;
                    if (
                      settings.confirmArchive &&
                      !confirm(`Archive ${serviceTitle(active)}?`)
                    ) return;
                    void setServiceArchived(user, active.id, true).then(async () => {
                      activeRef.current = null;
                      setActive(null);
                      await refreshLists();
                    });
                  }}
                >
                  Archive
                </button>
                <button
                  className="button danger-text"
                  type="button"
                  onClick={() => {
                    if (!user) return;
                    if (!confirm(`Remove ${serviceTitle(active)}? Attendance history will be preserved.`)) return;
                    void removeService(user, active.id).then(async () => {
                      activeRef.current = null;
                      setActive(null);
                      await refreshLists();
                    });
                  }}
                >
                  Remove
                </button>
              </>
            )}
          </div>
        </div>
        <div className="attendance-heading attendance-service-heading">
          <div>
            <p className="eyebrow">{formatChurchDate(active.serviceDate, settings)}</p>
            <h1>{serviceTitle(active)}</h1>
            <p>
              {active.serviceTime ? `${displayServiceTime(active.serviceTime)} · ` : ""}
              {serviceLocked
                ? "This completed service is read-only."
                : "Select every person who attended. Changes save to this device immediately."}
            </p>
          </div>
        </div>
        {serviceLocked && (
          <div className="completed-service-lock" role="status">
            <span className="status-pill completed">Completed</span>
            <span>
              This service is locked.
              {isAdmin(user) && settings.allowAdminReopenCompleted
                ? " Reopen Service to make changes."
                : " An administrator can reopen it if changes are needed."}
            </span>
          </div>
        )}
        {settings.showAttendanceTotals && (
          <section className="attendance-metrics" aria-live="polite">
            <article className="attendance-metric members">
              <span>Members Present</span>
              <strong>{presentCounts.members}</strong>
            </article>
            <article className="attendance-metric visitors">
              <span>Visitors</span>
              <strong>{presentCounts.visitors}</strong>
            </article>
            <article className="attendance-metric total">
              <span>Total Present</span>
              <strong>{presentCounts.total}</strong>
              <small>Members + visitors</small>
            </article>
            <article className="attendance-metric status">
              <span>Service Status</span>
              <strong>
                {active.status === "draft" ? "In Progress" : "Completed"}
              </strong>
            </article>
          </section>
        )}
        {actionFeedback && (
          <div className="notice success" role="status">
            {actionFeedback}
          </div>
        )}
        {activeVisitorConflicts.map((item) => (
          <div className="notice warning visitor-conflict-notice" key={item.id}>
            <div>
              <strong>
                {item.conflict?.visitorName ?? "A visitor"} has changes from
                another device.
              </strong>
              <span>
                {isAdmin(user)
                  ? "Review them before finishing this service."
                  : "An administrator needs to review them before this service can be finished."}
              </span>
            </div>
            {isAdmin(user) && (
              <button
                className="button secondary"
                type="button"
                onClick={() => setReviewingConflict(item)}
              >
                Review Conflict
              </button>
            )}
          </div>
        ))}
        <section className="panel attendance-people-workspace">
          <div
            className="attendance-tabs"
            role="tablist"
            aria-label="Attendance people"
          >
            <button
              ref={memberTabRef}
              id="attendance-members-tab"
              role="tab"
              type="button"
              aria-selected={attendanceTab === "members"}
              aria-controls="attendance-members-panel"
              tabIndex={attendanceTab === "members" ? 0 : -1}
              className={attendanceTab === "members" ? "active" : ""}
              onClick={() => selectAttendanceTab("members")}
              onKeyDown={(event) => {
                if (event.key !== "ArrowRight") return;
                event.preventDefault();
                selectAttendanceTab("visitors", true);
              }}
            >
              <strong>Members</strong>
              <span>{presentCounts.members} present</span>
            </button>
            <button
              ref={visitorTabRef}
              id="attendance-visitors-tab"
              role="tab"
              type="button"
              aria-selected={attendanceTab === "visitors"}
              aria-controls="attendance-visitors-panel"
              tabIndex={attendanceTab === "visitors" ? 0 : -1}
              className={attendanceTab === "visitors" ? "active" : ""}
              onClick={() => selectAttendanceTab("visitors")}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft") {
                  event.preventDefault();
                  selectAttendanceTab("members", true);
                } else if (event.key === "ArrowRight" && isAdmin(user)) {
                  event.preventDefault();
                  selectAttendanceTab("history", true);
                }
              }}
            >
              <strong>{settings.visitorLabel}s</strong>
              <span>{presentCounts.visitors}</span>
            </button>
            {isAdmin(user) && (
              <button
                ref={historyTabRef}
                id="attendance-history-tab"
                role="tab"
                type="button"
                aria-selected={attendanceTab === "history"}
                aria-controls="attendance-history-panel"
                tabIndex={attendanceTab === "history" ? 0 : -1}
                className={attendanceTab === "history" ? "active" : ""}
                onClick={() => selectAttendanceTab("history")}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowLeft") return;
                  event.preventDefault();
                  selectAttendanceTab("visitors", true);
                }}
              >
                <strong>History</strong>
                <span>Audit trail</span>
              </button>
            )}
          </div>

          {attendanceTab === "members" && (
            <div
              id="attendance-members-panel"
              role="tabpanel"
              aria-labelledby="attendance-members-tab"
              className="attendance-tab-panel"
            >
              <div className="panel-toolbar attendance-tab-toolbar">
                <label className="search-field">
                  <span className="sr-only">Search members</span>
                  <span aria-hidden="true">⌕</span>
                  <input
                    type="search"
                    placeholder="Search members"
                    value={memberSearch}
                    onChange={(event) => setMemberSearch(event.target.value)}
                  />
                </label>
                <button
                  className="button secondary"
                  type="button"
                  disabled={serviceLocked}
                  onClick={() => setMemberOpen(true)}
                >
                  + Add Member
                </button>
              </div>
              <div className="attendance-controls">
                <div
                  className="attendance-filters"
                  role="group"
                  aria-label="Filter members"
                >
                  {(["all", "present", "absent"] as const).map((filter) => (
                    <button
                      className={
                        attendanceFilter === filter
                          ? "attendance-filter active"
                          : "attendance-filter"
                      }
                      type="button"
                      key={filter}
                      aria-pressed={attendanceFilter === filter}
                      onClick={() => setAttendanceFilter(filter)}
                    >
                      {filter === "all"
                        ? `All (${memberCounts.total})`
                        : filter === "present"
                          ? `Present (${memberCounts.present})`
                          : `Absent (${memberCounts.absent})`}
                    </button>
                  ))}
                </div>
                <span className="attendance-context-count">
                  {memberCounts.present} of {memberCounts.total} members present
                </span>
                <button
                  className="button subtle mark-absent-button"
                  type="button"
                  disabled={serviceLocked || memberCounts.present === 0}
                  onClick={() => void markAllAbsent()}
                >
                  Mark all absent
                </button>
              </div>
              <div className="member-card-grid">
                {filteredMembers.map((member) => {
                  const checked = selected.has(member.id);
                  const pending =
                    pendingRecordKeys.has(`people:${member.id}`) ||
                    pendingRecordKeys.has(
                      `service_attendance:${active.id}:${member.id}`,
                    );
                  return (
                    <label
                      id={`member-card-${member.id}`}
                      className={[
                        "attendance-person-card",
                        checked ? "selected" : "",
                        serviceLocked ? "locked" : "",
                        recentMemberId === member.id ? "recently-added" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      key={member.id}
                      aria-disabled={serviceLocked}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={serviceLocked}
                        aria-label={`${member.displayName}, ${
                          checked ? "present" : "absent"
                        }`}
                        onChange={() => void toggleMember(member.id)}
                      />
                      <span className="attendance-card-check" aria-hidden="true">
                        {checked ? "✓" : ""}
                      </span>
                      <span className="attendance-card-name">
                        <HighlightedText
                          text={member.displayName}
                          query={memberSearch}
                        />
                      </span>
                      <span className="attendance-card-state">
                        {checked
                          ? "Present"
                          : serviceLocked
                            ? "Absent"
                            : "Mark Present"}
                      </span>
                      {pending && (
                        <span className="card-sync-pending">
                          ● Waiting to sync
                        </span>
                      )}
                    </label>
                  );
                })}
              </div>
              {filteredMembers.length === 0 && (
                <div className="attendance-empty">
                  <strong>No members match this view.</strong>
                  <span>Try another filter or clear the search.</span>
                </div>
              )}
            </div>
          )}

          {attendanceTab === "visitors" && (
            <div
              id="attendance-visitors-panel"
              role="tabpanel"
              aria-labelledby="attendance-visitors-tab"
              className="attendance-tab-panel"
            >
              <div className="panel-toolbar attendance-tab-toolbar">
                <label className="search-field">
                  <span className="sr-only">Search named visitors</span>
                  <span aria-hidden="true">⌕</span>
                  <input
                    type="search"
                    placeholder={`Search ${settings.visitorLabel.toLocaleLowerCase()}s`}
                    value={visitorSearch}
                    onChange={(event) => setVisitorSearch(event.target.value)}
                  />
                </label>
                <button
                  className="button primary"
                  type="button"
                  disabled={serviceLocked}
                  onClick={() => setVisitorOpen(true)}
                >
                  + Add Visitor
                </button>
              </div>
              <section className="unnamed-visitor-counter">
                <div>
                  <h2>Unnamed Visitors</h2>
                  <p>People attending whose names were not recorded.</p>
                </div>
                <div
                  className="visitor-stepper"
                  role="group"
                  aria-label="Unnamed visitor count"
                >
                  <button
                    type="button"
                    aria-label="Remove one unnamed visitor"
                    disabled={
                      serviceLocked ||
                      (active.unnamedVisitorCount ?? 0) === 0
                    }
                    onClick={() => void changeUnnamedVisitorCount(-1)}
                  >
                    −
                  </button>
                  <strong aria-live="polite">
                    {active.unnamedVisitorCount ?? 0}
                  </strong>
                  <button
                    type="button"
                    aria-label="Add one unnamed visitor"
                    disabled={serviceLocked}
                    onClick={() => void changeUnnamedVisitorCount(1)}
                  >
                    +
                  </button>
                </div>
              </section>
              <div className="visitor-tab-summary">
                <strong>{presentCounts.visitors} visitors</strong>
                <span>Everyone visiting this service</span>
              </div>
              <div className="visitor-card-grid">
                {filteredVisitors.map((visitor) => (
                  <article
                    id={`visitor-card-${visitor.id}`}
                    className={[
                      "visitor-person-card",
                      recentVisitorId === visitor.id ? "recently-added" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    key={visitor.id}
                  >
                    <span className="visitor-present-check" aria-hidden="true">
                      ✓
                    </span>
                    <span className="visitor-name">
                      <strong>
                        <HighlightedText
                          text={visitor.displayName}
                          query={visitorSearch}
                        />
                      </strong>
                      <small>
                        {visitor.savedAsMember
                          ? "Also saved as member"
                          : "Present this service"}
                      </small>
                      {settings.allowVisitorNotes && visitor.notes && (
                        <small>{visitor.notes}</small>
                      )}
                      {pendingRecordKeys.has(
                        `service_visitors:${visitor.id}`,
                      ) && (
                        <small className="card-sync-pending">
                          ● Waiting to sync
                        </small>
                      )}
                    </span>
                    <span className="visitor-actions">
                      {isAdmin(user) && (
                        <button
                          className="button subtle"
                          type="button"
                          aria-label={`View history for ${visitor.displayName}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            setHistoryVisitor(visitor);
                          }}
                        >
                          History
                        </button>
                      )}
                      <button
                        className="button subtle"
                        type="button"
                        aria-label={`Edit ${visitor.displayName}`}
                        disabled={serviceLocked}
                        onClick={(event) => {
                          event.stopPropagation();
                          setEditingVisitor(visitor);
                        }}
                      >
                        Edit
                      </button>
                      <button
                        className="button danger-text"
                        type="button"
                        aria-label={`Remove ${visitor.displayName}`}
                        disabled={serviceLocked}
                        onClick={(event) => {
                          event.stopPropagation();
                          if (!user) return;
                          if (
                            settings.confirmVisitorRemoval &&
                            !confirm(
                              "Remove this visitor from the service? This will remove their attendance entry from this service.",
                            )
                          ) {
                            return;
                          }
                          void removeServiceVisitor(user, visitor.id).then(() =>
                            openService(active, { resetView: false }),
                          );
                        }}
                      >
                        Remove
                      </button>
                    </span>
                  </article>
                ))}
              </div>
              {filteredVisitors.length === 0 && (
                <div className="attendance-empty">
                  <strong>
                    {visitorSearch
                      ? `No ${settings.visitorLabel.toLocaleLowerCase()}s match your search.`
                      : `No named ${settings.visitorLabel.toLocaleLowerCase()}s yet.`}
                  </strong>
                  <span>
                    {visitorSearch
                      ? "Try another name or clear the search."
                      : "Use Add Visitor when a name is available."}
                  </span>
                </div>
              )}
            </div>
          )}
          {attendanceTab === "history" && isAdmin(user) && (
            <div
              id="attendance-history-panel"
              role="tabpanel"
              aria-labelledby="attendance-history-tab"
              className="attendance-tab-panel service-history-panel"
            >
              <AuditHistory
                relatedEntityId={active.id}
                compact
              />
            </div>
          )}
        </section>
        <div className="sticky-actions attendance-mobile-actions">
          <span>{presentCounts.total} present</span>
          <div>
            {active.status === "completed" ? (
              isAdmin(user) &&
              settings.allowAdminReopenCompleted && (
                <button
                  className="button secondary"
                  type="button"
                  disabled={serviceAction !== null}
                  onClick={() => void setStatus("draft")}
                >
                  {serviceAction === "draft" ? "Saving…" : "Reopen Service"}
                </button>
              )
            ) : (
              <>
                <button
                  className="button subtle"
                  type="button"
                  disabled={serviceAction !== null}
                  onClick={() => void setStatus("draft")}
                >
                  {serviceAction === "draft" ? "Saving…" : "Save Draft"}
                </button>
                <button
                  className="button primary"
                  type="button"
                  disabled={serviceAction !== null}
                  onClick={() => void setStatus("completed")}
                >
                  {serviceAction === "completed" ? "Saving…" : "Finish Service"}
                </button>
              </>
            )}
          </div>
        </div>
        {memberOpen && !serviceLocked && (
          <QuickAddMemberModal
            onClose={() => setMemberOpen(false)}
            onCreate={createQuickMember}
            onUseExisting={useExistingQuickMember}
          />
        )}
        {reviewingConflict?.conflict && isAdmin(user) && (
          <VisitorConflictDialog
            item={reviewingConflict}
            onClose={() => setReviewingConflict(null)}
            onResolve={async (strategy, manual) => {
              if (!user) return;
              await resolveVisitorConflict(
                user.organizationId,
                reviewingConflict.id,
                strategy,
                manual,
              );
              setReviewingConflict(null);
              await syncNow();
              await refreshLists();
              await openService(active, { resetView: false });
            }}
          />
        )}
        {visitorOpen && !serviceLocked && (
          <VisitorModal
            settings={settings}
            onClose={() => setVisitorOpen(false)}
            onSave={async (input) => {
              if (!user) return;
              const { visitor } = await addServiceVisitor(
                user,
                active.id,
                input,
              );
              setAttendanceTab("visitors");
              setRecentVisitorId(visitor.id);
              setVisitorOpen(false);
              await openService(active, { resetView: false });
              await refreshLists();
              highlightCard(`visitor-card-${visitor.id}`);
            }}
          />
        )}
        {editingVisitor && !serviceLocked && (
          <VisitorModal
            settings={settings}
            existing={editingVisitor}
            onClose={() => setEditingVisitor(null)}
            onSave={async (input) => {
              if (!user) return;
              await editServiceVisitor(user, editingVisitor.id, input);
              setEditingVisitor(null);
              await openService(active, { resetView: false });
            }}
          />
        )}
        {historyVisitor && isAdmin(user) && (
          <div className="modal-backdrop">
            <section
              className="modal audit-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="visitor-history-title"
            >
              <div className="modal-heading">
                <div>
                  <p className="eyebrow">Visitor history</p>
                  <h2 id="visitor-history-title">
                    {historyVisitor.displayName}
                  </h2>
                </div>
                <button
                  className="icon-button"
                  type="button"
                  aria-label="Close visitor history"
                  onClick={() => setHistoryVisitor(null)}
                >
                  ×
                </button>
              </div>
              <AuditHistory
                entityType="visitor"
                entityId={historyVisitor.id}
                compact
              />
            </section>
          </div>
        )}
        {editOpen && !serviceLocked && (
          <ServiceModal
            existing={active}
            onClose={() => setEditOpen(false)}
            onSaved={async (service) => {
              setEditOpen(false);
              await refreshLists();
              await openService(service);
            }}
          />
        )}
      </div>
    );
  }

  return (
    <div className="page-stack">
      <div className="page-heading with-action">
        <div>
          <p className="eyebrow">Attendance</p>
          <h1>Services</h1>
          <p>Create a service, then record attendance by name.</p>
        </div>
        <button className="button primary" type="button" onClick={() => setCreateOpen(true)}>＋ Create service</button>
      </div>
      <section className="panel service-directory-toolbar">
        <label className="search-field">
          <span className="sr-only">Search organization services</span>
          <span aria-hidden="true">⌕</span>
          <input
            type="search"
            value={serviceSearch}
            placeholder="Search services, dates, months, or years"
            onChange={(event) => setServiceSearch(event.target.value)}
          />
        </label>
        <div className="service-directory-filters" role="group" aria-label="Filter services">
          {(["all", "draft", "completed"] as const).map((filter) => (
            <button
              className={serviceFilter === filter ? "active" : ""}
              type="button"
              key={filter}
              aria-pressed={serviceFilter === filter}
              onClick={() => setServiceFilter(filter)}
            >
              {filter === "all"
                ? "All"
                : filter === "draft"
                  ? "Draft"
                  : "Completed"}
            </button>
          ))}
        </div>
      </section>
      <section className="service-directory" aria-label="Organization services">
        {serviceGroups.map((yearGroup) => (
          <details
            className="service-year-folder"
            key={yearGroup.year}
            open={
              Boolean(serviceSearch) ||
              serviceFilter !== "all" ||
              expandedYears.has(yearGroup.year)
            }
            onToggle={(event) =>
              toggleFolder("years", yearGroup.year, event.currentTarget.open)
            }
          >
            <summary>
              <span className="folder-icon" aria-hidden="true">▸</span>
              <strong>{yearGroup.year}</strong>
              <span>
                {yearGroup.serviceCount}{" "}
                {yearGroup.serviceCount === 1 ? "service" : "services"}
              </span>
            </summary>
            <div className="service-month-list">
              {yearGroup.months.map((monthGroup) => (
                <details
                  className="service-month-folder"
                  key={monthGroup.key}
                  open={
                    Boolean(serviceSearch) ||
                    serviceFilter !== "all" ||
                    expandedMonths.has(monthGroup.key)
                  }
                  onToggle={(event) =>
                    toggleFolder(
                      "months",
                      monthGroup.key,
                      event.currentTarget.open,
                    )
                  }
                >
                  <summary>
                    <span className="folder-icon" aria-hidden="true">▸</span>
                    <strong>{monthGroup.monthName}</strong>
                    <span>
                      {monthGroup.services.length}{" "}
                      {monthGroup.services.length === 1
                        ? "service"
                        : "services"}
                    </span>
                  </summary>
                  <div className="service-folder-rows">
                    {monthGroup.services.map((item) => (
                      <button
                        className="service-directory-row"
                        type="button"
                        key={item.service.id}
                        onClick={() => void openService(item.service)}
                      >
                        <span className="service-directory-date">
                          <strong>
                            {formatChurchDate(item.service.serviceDate, settings, {
                              day: "2-digit",
                            })}
                          </strong>
                          <span>
                            {formatChurchDate(item.service.serviceDate, settings, {
                              weekday: "short",
                            })}
                          </span>
                        </span>
                        <span className="service-directory-main">
                          <strong>{serviceTitle(item.service)}</strong>
                          <span>
                            {formatChurchDate(item.service.serviceDate, settings, {
                              year: "numeric",
                            })}
                            {item.service.serviceTime
                              ? ` · ${displayServiceTime(item.service.serviceTime)}`
                              : ""}
                          </span>
                          <small>
                            Updated{" "}
                            {new Date(item.service.updatedAt).toLocaleString()}
                            {item.lastEditor
                              ? ` by ${item.lastEditor}`
                              : ""}
                          </small>
                        </span>
                        <span className="service-directory-counts">
                          <strong>{item.totalPresent}</strong>
                          <span>Total present</span>
                          <small>
                            {item.membersPresent} members · {item.visitorsPresent} visitors
                          </small>
                        </span>
                        <span className="service-directory-state">
                          <span
                            className={`status-pill ${item.service.status}`}
                            aria-label={`Service status: ${item.service.status}`}
                          >
                            {item.service.status === "draft"
                              ? "Draft"
                              : "Completed"}
                          </span>
                          {item.pendingSync && (
                            <small
                              className={`service-sync-state ${item.syncState}`}
                              aria-label={`Synchronization status: ${
                                item.syncState === "conflict" && !isAdmin(user)
                                  ? "needs attention"
                                  : item.syncState
                              }`}
                            >
                              {item.syncState === "uploading"
                                ? "↑ Uploading"
                                : item.syncState === "conflict"
                                  ? isAdmin(user)
                                    ? "! Conflict"
                                    : "! Needs attention"
                                  : "● Sync pending"}
                            </small>
                          )}
                          {!item.pendingSync && (
                            <small
                              className="service-sync-state synced"
                              aria-label="Synchronization status: synced"
                            >
                              ✓ Synced
                            </small>
                          )}
                        </span>
                        <span className="service-row-arrow" aria-hidden="true">
                          ›
                        </span>
                      </button>
                    ))}
                  </div>
                </details>
              ))}
            </div>
          </details>
        ))}
        {services.length > 0 && visibleServiceDirectory.length === 0 && (
          <section className="empty-panel full-width">
            <span className="empty-icon" aria-hidden="true">⌕</span>
            <h2>No services match</h2>
            <p>Try another search or select a different status.</p>
          </section>
        )}
        {!services.length && (
          <section className="empty-panel full-width">
            <span className="empty-icon" aria-hidden="true">+</span>
            <h2>Create your first service</h2>
            <p>The active member list will be ready for attendance as soon as you create it.</p>
            <button className="button primary" type="button" onClick={() => setCreateOpen(true)}>Create service</button>
          </section>
        )}
      </section>
      {createOpen && <ServiceModal settings={settings} onClose={() => setCreateOpen(false)} onSaved={async (service) => { setCreateOpen(false); await refreshLists(); await openService(service); }} />}
    </div>
  );

  function ServiceModal({ onClose, onSaved, existing, settings: modalSettings = settings }: { onClose: () => void; onSaved: (service: ChurchService) => void; existing?: ChurchService; settings?: ApplicationSettings }) {
    const enabledTypes = modalSettings.serviceTypes.filter((item) => item.enabled);
    const availableTypes =
      existing && !enabledTypes.some((item) => item.name === existing.serviceType)
        ? [
            ...enabledTypes,
            {
              id: `historical-${existing.serviceType}`,
              name: existing.serviceType,
              enabled: false,
              system: false,
            },
          ]
        : enabledTypes;
    const initialType = existing?.serviceType ?? availableTypes[0]?.name ?? SERVICE_TYPES[0];
    const [date, setDate] = useState(
      existing?.serviceDate ?? localDate(modalSettings.timezone),
    );
    const [type, setType] = useState<ServiceType>(initialType);
    const [serviceTime, setServiceTime] = useState(
      existing?.serviceTime ??
        availableTypes.find((item) => item.name === initialType)?.defaultTime ??
        "",
    );
    const [customName, setCustomName] = useState(existing?.customName ?? "");
    async function submit(event: FormEvent) {
      event.preventDefault();
      if (!user) return;
      const service = await saveService(user, {
        id: existing?.id,
        serviceDate: date,
        serviceType: type,
        customName,
        serviceTime,
        status: existing?.status ?? modalSettings.defaultServiceStatus,
      });
      onSaved(service);
    }
    return (
      <div className="modal-backdrop">
        <section className="modal" role="dialog" aria-modal="true" aria-labelledby="create-service-title">
          <div className="modal-heading"><div><p className="eyebrow">{existing ? "Service details" : "New attendance list"}</p><h2 id="create-service-title">{existing ? "Edit service" : "Create a service"}</h2></div><button className="icon-button" aria-label="Close" type="button" onClick={onClose}>×</button></div>
          <form className="form-stack" onSubmit={submit}>
            <label>Service date<input type="date" value={date} onChange={(event) => setDate(event.target.value)} required /></label>
            <label>Service type<select value={type} onChange={(event) => {
              const nextType = event.target.value;
              setType(nextType);
              setServiceTime(availableTypes.find((item) => item.name === nextType)?.defaultTime ?? "");
            }}>{availableTypes.map((option) => <option key={option.id} value={option.name}>{option.name}</option>)}</select></label>
            <label>Service time <span className="optional">(optional)</span><input type="time" value={serviceTime} onChange={(event) => setServiceTime(event.target.value)} /></label>
            {(availableTypes.find((item) => item.name === type)?.id === "special-service" || type === "Other") && <label>Custom service name <span className="optional">(optional)</span><input value={customName} onChange={(event) => setCustomName(event.target.value)} placeholder="e.g. Christmas Eve" /></label>}
            <div className="modal-actions"><button className="button subtle" type="button" onClick={onClose}>Cancel</button><button className="button primary">{existing ? "Save changes" : "Create and take attendance"}</button></div>
          </form>
        </section>
      </div>
    );
  }
}

const VISITOR_CONFLICT_LABELS: Record<string, string> = {
  first_name: "First name",
  last_name: "Last name",
  display_name: "Display name",
  notes: "Notes",
  deleted_at: "Removed from service",
  service_id: "Service",
  saved_as_member: "Saved as member",
  member_person_id: "Linked member",
};

function conflictValue(value: unknown) {
  if (value === undefined || value === null || value === "") return "Not set";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

function VisitorConflictDialog({
  item,
  onClose,
  onResolve,
}: {
  item: SyncQueueItem;
  onClose: () => void;
  onResolve: (
    strategy: "local" | "server" | "manual",
    manual?: { firstName: string; lastName: string; notes?: string },
  ) => Promise<void>;
}) {
  const conflict = item.conflict!;
  const [manualOpen, setManualOpen] = useState(false);
  const [firstName, setFirstName] = useState(
    String(item.payload.first_name ?? ""),
  );
  const [lastName, setLastName] = useState(
    String(item.payload.last_name ?? ""),
  );
  const [notes, setNotes] = useState(String(item.payload.notes ?? ""));
  const [saving, setSaving] = useState(false);

  async function resolve(
    strategy: "local" | "server" | "manual",
    manual?: { firstName: string; lastName: string; notes?: string },
  ) {
    setSaving(true);
    try {
      await onResolve(strategy, manual);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <section
        className="modal visitor-conflict-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="visitor-conflict-title"
      >
        <div className="modal-heading">
          <div>
            <p className="eyebrow">Synchronization review</p>
            <h2 id="visitor-conflict-title">{conflict.visitorName}</h2>
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
        <p>
          This visitor was changed on this device and on another device. Choose
          which information should be kept.
        </p>
        <div className="visitor-conflict-fields">
          {conflict.fields.map((field) => (
            <section key={field.field}>
              <h3>{VISITOR_CONFLICT_LABELS[field.field] ?? field.field}</h3>
              <div>
                <span>
                  <small>This device</small>
                  <strong>{conflictValue(field.localValue)}</strong>
                </span>
                <span>
                  <small>Server</small>
                  <strong>{conflictValue(field.serverValue)}</strong>
                </span>
              </div>
            </section>
          ))}
        </div>
        <p className="form-note">
          Local update:{" "}
          {conflict.localUpdatedAt
            ? new Date(conflict.localUpdatedAt).toLocaleString()
            : "Unknown"}
          {" · "}Server update:{" "}
          {conflict.serverUpdatedAt
            ? new Date(conflict.serverUpdatedAt).toLocaleString()
            : "Unknown"}
        </p>
        <details className="visitor-conflict-diagnostics">
          <summary>Technical details</summary>
          <dl>
            <div>
              <dt>Visitor record</dt>
              <dd>{conflict.visitorId}</dd>
            </div>
            <div>
              <dt>Service record</dt>
              <dd>{conflict.serviceId}</dd>
            </div>
            <div>
              <dt>Organization</dt>
              <dd>{conflict.organizationId}</dd>
            </div>
            <div>
              <dt>Versions</dt>
              <dd>
                This device {conflict.localVersion ?? "unknown"} · Server{" "}
                {conflict.serverVersion ?? "unknown"}
              </dd>
            </div>
            <div>
              <dt>Last editors</dt>
              <dd>
                This device {conflict.localUpdatedBy ?? "unknown"} · Server{" "}
                {conflict.serverUpdatedBy ?? "unknown"}
              </dd>
            </div>
          </dl>
        </details>
        {manualOpen && (
          <div className="form-stack visitor-conflict-manual">
            <div className="form-grid">
              <label>
                First name
                <input
                  value={firstName}
                  onChange={(event) => setFirstName(event.target.value)}
                />
              </label>
              <label>
                Last name
                <input
                  value={lastName}
                  onChange={(event) => setLastName(event.target.value)}
                />
              </label>
            </div>
            <label>
              Notes
              <textarea
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
              />
            </label>
            <button
              className="button primary"
              type="button"
              disabled={saving}
              onClick={() =>
                void resolve("manual", { firstName, lastName, notes })
              }
            >
              {saving ? "Resolving…" : "Save merged visitor"}
            </button>
          </div>
        )}
        <div className="modal-actions visitor-conflict-actions">
          <button
            className="button subtle"
            type="button"
            disabled={saving}
            onClick={() => void resolve("server")}
          >
            Keep Server
          </button>
          <button
            className="button secondary"
            type="button"
            disabled={saving}
            onClick={() => setManualOpen((current) => !current)}
          >
            Merge Manually
          </button>
          <button
            className="button primary"
            type="button"
            disabled={saving}
            onClick={() => void resolve("local")}
          >
            Keep Local
          </button>
        </div>
      </section>
    </div>
  );
}

function HighlightedText({ text, query }: { text: string; query: string }) {
  const trimmed = query.trim();
  if (!trimmed) return text;
  const index = text.toLocaleLowerCase().indexOf(trimmed.toLocaleLowerCase());
  if (index < 0) return text;
  return (
    <>
      {text.slice(0, index)}
      <mark className="search-match">
        {text.slice(index, index + trimmed.length)}
      </mark>
      {text.slice(index + trimmed.length)}
    </>
  );
}

function formatMemberMatchDate(value: string) {
  const date = new Date(value.length === 10 ? `${value}T12:00:00` : value);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function QuickAddMemberModal({
  onClose,
  onCreate,
  onUseExisting,
}: {
  onClose: () => void;
  onCreate: (
    firstName: string,
    lastName: string,
  ) => Promise<
    | Array<{ person: Person; lastAttendanceDate?: string }>
    | undefined
  >;
  onUseExisting: (person: Person) => Promise<void>;
}) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [matches, setMatches] = useState<
    Array<{ person: Person; lastAttendanceDate?: string }>
  >([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function create() {
    setSaving(true);
    setError("");
    try {
      const exactMatches = await onCreate(firstName, lastName);
      if (exactMatches?.length) {
        setMatches(exactMatches);
        return;
      }
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not add member.");
    } finally {
      setSaving(false);
    }
  }

  async function handleUseExisting(person: Person) {
    setSaving(true);
    setError("");
    try {
      await onUseExisting(person);
      onClose();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not use this member.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="quick-member-title"
      >
        <div className="modal-heading">
          <div>
            <p className="eyebrow">This service</p>
            <h2 id="quick-member-title">Add a member</h2>
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
        <form
          className="form-stack"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <div className="form-grid">
            <label>
              First name
              <input
                autoFocus
                value={firstName}
                onChange={(event) => {
                  setFirstName(event.target.value);
                  setMatches([]);
                }}
                required
              />
            </label>
            <label>
              Last name
              <input
                value={lastName}
                onChange={(event) => {
                  setLastName(event.target.value);
                  setMatches([]);
                }}
                required
              />
            </label>
          </div>
          {matches.length === 1 && (
            <div className="notice warning duplicate-member-warning" role="alert">
              <strong>
                {matches[0].person.isActive && !matches[0].person.deletedAt
                  ? "This member already exists."
                  : matches[0].person.deletedAt
                    ? "A previously removed member with this name already exists."
                    : "An inactive member with this name already exists."}
              </strong>
              <span>
                {matches[0].person.isActive && !matches[0].person.deletedAt
                  ? "Use the existing member instead of creating a duplicate."
                  : matches[0].person.deletedAt
                    ? "Would you like to restore them?"
                    : "Would you like to reactivate the existing member instead?"}
              </span>
              <div>
                <button
                  className="button secondary"
                  type="button"
                  disabled={saving}
                  onClick={() => void handleUseExisting(matches[0].person)}
                >
                  {matches[0].person.isActive && !matches[0].person.deletedAt
                    ? "Use Existing Member"
                    : matches[0].person.deletedAt
                      ? "Restore Existing Member"
                      : "Reactivate Existing Member"}
                </button>
              </div>
            </div>
          )}
          {matches.length > 1 && (
            <div className="notice warning duplicate-member-warning" role="alert">
              <strong>Multiple members share this name.</strong>
              <span>
                Choose the correct existing record. No member will be restored
                automatically.
              </span>
              <div className="member-match-list">
                {matches.map(({ person, lastAttendanceDate }) => (
                  <article key={person.id}>
                    <div>
                      <strong>{person.displayName}</strong>
                      <span>
                        {person.deletedAt
                          ? "Removed"
                          : person.isActive
                            ? "Active"
                            : "Inactive"}{" "}
                        · Added {formatMemberMatchDate(person.createdAt)} ·
                        Last attendance{" "}
                        {lastAttendanceDate
                          ? formatMemberMatchDate(lastAttendanceDate)
                          : "Not available"}
                      </span>
                    </div>
                    <button
                      className="button secondary"
                      type="button"
                      disabled={saving}
                      onClick={() => void handleUseExisting(person)}
                    >
                      {person.isActive && !person.deletedAt
                        ? "Use Existing Member"
                        : person.deletedAt
                          ? "Restore Existing Member"
                          : "Reactivate Existing Member"}
                    </button>
                  </article>
                ))}
              </div>
            </div>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <p className="form-note">
            The member will be added to the church directory and marked present
            for this service. This works while offline.
          </p>
          <div className="modal-actions">
            <button
              className="button subtle"
              type="button"
              disabled={saving}
              onClick={onClose}
            >
              Cancel
            </button>
            {matches.length === 0 && (
              <button className="button primary" disabled={saving}>
                {saving ? "Adding…" : "Add member and mark present"}
              </button>
            )}
          </div>
        </form>
      </section>
    </div>
  );
}

function VisitorModal({
  onClose,
  onSave,
  existing,
  settings,
}: {
  onClose: () => void;
  onSave: (input: {
    firstName: string;
    lastName: string;
    saveAsMember: boolean;
    notes?: string;
    fallbackName?: string;
  }) => void;
  existing?: ServiceVisitor;
  settings: ApplicationSettings;
}) {
  const [firstName, setFirstName] = useState(existing?.firstName ?? "");
  const [lastName, setLastName] = useState(existing?.lastName ?? "");
  const [saveAsMember, setSaveAsMember] = useState(
    existing?.savedAsMember ?? false,
  );
  const [notes, setNotes] = useState(existing?.notes ?? "");
  function submit(event: FormEvent) {
    event.preventDefault();
    onSave({
      firstName,
      lastName,
      saveAsMember,
      notes,
      fallbackName: settings.visitorLabel,
    });
  }
  return (
    <div className="modal-backdrop">
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="visitor-title">
        <div className="modal-heading"><div><p className="eyebrow">This service</p><h2 id="visitor-title">{existing ? `Edit ${settings.visitorLabel.toLocaleLowerCase()}` : `Add a ${settings.visitorLabel.toLocaleLowerCase()}`}</h2></div><button className="icon-button" aria-label="Close" type="button" onClick={onClose}>×</button></div>
        <form className="form-stack" onSubmit={submit}>
          <div className="form-grid">
            <label>First name<input autoFocus value={firstName} onChange={(event) => setFirstName(event.target.value)} required={settings.requireVisitorName} /></label>
            <label>Last name<input value={lastName} onChange={(event) => setLastName(event.target.value)} required={settings.requireVisitorName} /></label>
          </div>
          {settings.allowVisitorNotes && (
            <label>
              Notes <span className="optional">(optional)</span>
              <textarea
                value={notes}
                maxLength={2000}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="Accessibility, follow-up, or service notes"
              />
            </label>
          )}
          {!existing && (
            <label className="choice-row">
              <input type="checkbox" checked={saveAsMember} onChange={(event) => setSaveAsMember(event.target.checked)} />
              <span><strong>Save as member for future services</strong><small>They will appear in future attendance lists.</small></span>
            </label>
          )}
          {existing?.savedAsMember && (
            <p className="form-note">
              This visitor is linked to a permanent member. Editing this
              service entry does not change the permanent member record.
            </p>
          )}
          <div className="modal-actions"><button className="button subtle" type="button" onClick={onClose}>Cancel</button><button className="button primary">{existing ? "Save visitor" : "Add visitor"}</button></div>
        </form>
      </section>
    </div>
  );
}
