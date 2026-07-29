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
import {
  SERVICE_TYPES,
  DEFAULT_APPLICATION_SETTINGS,
  normalizeName,
  type ApplicationSettings,
  type ChurchService,
  type Person,
  type ServiceType,
  type ServiceVisitor,
} from "@/lib/domain";
import {
  addServiceVisitor,
  editServiceVisitor,
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
  const [search, setSearch] = useState("");
  const [attendanceFilter, setAttendanceFilter] =
    useState<AttendanceFilter>("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [visitorOpen, setVisitorOpen] = useState(false);
  const [memberOpen, setMemberOpen] = useState(false);
  const [editingVisitor, setEditingVisitor] =
    useState<ServiceVisitor | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [serviceAction, setServiceAction] = useState<
    "draft" | "completed" | null
  >(null);
  const [actionFeedback, setActionFeedback] = useState("");
  const [serviceSearch, setServiceSearch] = useState("");
  const [serviceFilter, setServiceFilter] =
    useState<ServiceDirectoryFilter>("all");
  const [expandedYears, setExpandedYears] = useState<Set<string>>(new Set());
  const [expandedMonths, setExpandedMonths] = useState<Set<string>>(new Set());
  const handledDashboardIntent = useRef("");
  const initializedServiceFolders = useRef("");
  const selectedRef = useRef<Set<string>>(new Set());

  const refreshLists = useCallback(async () => {
    if (!user) return;
    const [directory, settingsRecord] = await Promise.all([
      loadOrganizationServiceDirectory(user.organizationId),
      getOrganizationSettings(user.organizationId),
    ]);
    const nextMembers = settingsRecord.settings.showInactiveInAttendance
      ? await listMembers(user.organizationId)
      : await listActiveMembers(user.organizationId);
    setServiceDirectory(directory);
    setServices(directory.map((item) => item.service));
    setMembers(nextMembers);
    setSettings(settingsRecord.settings);
  }, [user]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshLists(), 0);
    const unsubscribe = subscribeToDataChanges(() => void refreshLists());
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [refreshLists]);

  const openService = useCallback(async (service: ChurchService) => {
    const [attendance, nextVisitors] = await Promise.all([
      getServiceAttendance(service.id),
      listServiceVisitors(service.id),
    ]);
    setActive(service);
    const nextSelected = new Set(
      attendance.filter((item) => item.present).map((item) => item.personId),
    );
    selectedRef.current = nextSelected;
    setSelected(nextSelected);
    setVisitors(nextVisitors);
    setSearch("");
    setAttendanceFilter("all");
  }, []);

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
      if (parameters.get("visitor") === "1") setVisitorOpen(true);
    });
  }, [openService, services]);

  async function toggleMember(personId: string) {
    if (!user || !active) return;
    const present = !selectedRef.current.has(personId);
    const next = new Set(selectedRef.current);
    if (present) next.add(personId);
    else next.delete(personId);
    selectedRef.current = next;
    setSelected(next);
    await setMemberAttendance(user, active.id, personId, present);
  }

  async function markAllAbsent() {
    if (!user || !active || selectedRef.current.size === 0) return;
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
      const updated = await saveService(user, { ...active, status });
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
      search,
    );
  }, [attendanceFilter, members, search, selected, settings.attendanceSort]);

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
      ),
    [selected, settings.includeVisitorsInTotal, visitors],
  );

  const filteredVisitors = useMemo(
    () => filterAttendanceVisitors(visitors, attendanceFilter, search),
    [attendanceFilter, search, visitors],
  );

  async function createQuickMember(
    firstName: string,
    lastName: string,
    allowDuplicate = false,
  ) {
    if (!user || !active) return undefined;
    const displayName = `${firstName} ${lastName}`;
    const match = (await listMembers(user.organizationId)).find(
      (person) =>
        normalizeName(person.displayName) === normalizeName(displayName),
    );
    if (match && !allowDuplicate) return match;
    const member = await saveMember(user, { firstName, lastName });
    await setMemberAttendance(user, active.id, member.id, true);
    await refreshLists();
    await openService(active);
    return undefined;
  }

  async function useExistingQuickMember(person: Person) {
    if (!user || !active) return;
    if (!person.isActive) {
      if (!isAdmin(user)) {
        throw new Error(
          "This member is inactive. An administrator must reactivate them before attendance can be recorded.",
        );
      }
      await restoreMember(user, person.id);
    }
    await setMemberAttendance(user, active.id, person.id, true);
    await refreshLists();
    await openService(active);
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

  if (active) {
    return (
      <div className="attendance-workspace">
        <div className="service-topline attendance-service-header">
          <button className="button subtle" type="button" onClick={() => setActive(null)}>← All services</button>
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
                <button className="button subtle" type="button" onClick={() => setEditOpen(true)}>Edit</button>
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
              Select every person who attended. Changes save to this device immediately.
            </p>
          </div>
        </div>
        {settings.showAttendanceTotals && (
          <section className="attendance-metrics" aria-live="polite">
            <article className="attendance-metric total">
              <span>Total Present</span>
              <strong>{presentCounts.total}</strong>
              <small>Members + visitors</small>
            </article>
            <article className="attendance-metric members">
              <span>Members Present</span>
              <strong>{presentCounts.members}</strong>
            </article>
            <article className="attendance-metric visitors">
              <span>Visitors Present</span>
              <strong>{presentCounts.visitors}</strong>
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
        <section className="panel attendance-panel">
          <div className="panel-toolbar attendance-action-bar">
            <label className="search-field attendance-search">
              <span className="sr-only">Search members and visitors</span>
              <span aria-hidden="true">⌕</span>
              <input
                type="search"
                placeholder="Search members and visitors"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <div className="attendance-quick-actions">
              <button
                className="button secondary"
                type="button"
                onClick={() => setMemberOpen(true)}
              >
                + Add Member
              </button>
              <button
                className="button primary"
                type="button"
                onClick={() => setVisitorOpen(true)}
              >
                + Add Visitor
              </button>
            </div>
          </div>
          <div className="attendance-controls">
            <div
              className="attendance-filters"
              role="group"
              aria-label="Filter attendance list"
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
                    ? "All"
                    : filter === "present"
                      ? `Present (${memberCounts.present})`
                      : "Absent"}
                </button>
              ))}
            </div>
            <button
              className="button subtle mark-absent-button"
              type="button"
              disabled={memberCounts.present === 0}
              onClick={() => void markAllAbsent()}
            >
              Mark all absent
            </button>
          </div>
          <div className="attendance-list">
            <div className="attendance-column-heading">
              <h2>Members</h2>
              <span>{presentCounts.members} present</span>
            </div>
            {filteredMembers.map((member) => {
              const checked = selected.has(member.id);
              return (
                <label
                  className={checked ? "attendance-row selected" : "attendance-row"}
                  key={member.id}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    aria-label={`${member.displayName} present`}
                    onChange={() => void toggleMember(member.id)}
                  />
                  <span className="attendance-check" aria-hidden="true">
                    {checked ? "✓" : ""}
                  </span>
                  <span className="avatar">
                    {member.firstName[0]}
                    {member.lastName[0]}
                  </span>
                  <span className="attendance-name">
                    <HighlightedText text={member.displayName} query={search} />
                    <small>{checked ? "Present" : "Tap to mark present"}</small>
                  </span>
                </label>
              );
            })}
            {filteredMembers.length === 0 && (
              <div className="attendance-empty">
                <strong>No members match this view.</strong>
                <span>Try another filter or clear the search.</span>
              </div>
            )}
          </div>
          {attendanceFilter !== "absent" && (
            <div
              className={
                settings.showVisitorsSeparately
                  ? "visitor-summary"
                  : "visitor-summary integrated"
              }
            >
              {settings.showVisitorsSeparately && (
                <div className="attendance-column-heading">
                  <h2>{settings.visitorLabel}s</h2>
                  <span>{presentCounts.visitors} present</span>
                </div>
              )}
              {filteredVisitors.map((visitor) => (
                <div className="visitor-row visitor-attendance-row" key={visitor.id}>
                  <span className="visitor-present-check" aria-hidden="true">
                    ✓
                  </span>
                  <span className="visitor-avatar" aria-hidden="true">
                    {visitor.firstName[0] || "V"}
                    {visitor.lastName[0] || ""}
                  </span>
                  <span className="visitor-name">
                    <strong>
                      <HighlightedText
                        text={visitor.displayName}
                        query={search}
                      />
                    </strong>
                    <small>{visitor.savedAsMember ? "Saved as member" : "This service only"}</small>
                    {settings.allowVisitorNotes && visitor.notes && (
                      <small>{visitor.notes}</small>
                    )}
                  </span>
                  <span className="visitor-actions">
                    <button
                      className="button subtle"
                      type="button"
                      onClick={() => setEditingVisitor(visitor)}
                    >
                      Edit
                    </button>
                    <button
                      className="button danger-text"
                      type="button"
                      onClick={() => {
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
                          openService(active),
                        );
                      }}
                    >
                      Remove
                    </button>
                  </span>
                </div>
              ))}
              {filteredVisitors.length === 0 && (
                <div className="attendance-empty">
                  <strong>
                    {search
                      ? `No ${settings.visitorLabel.toLocaleLowerCase()}s match your search.`
                      : `No ${settings.visitorLabel.toLocaleLowerCase()}s yet.`}
                  </strong>
                  <span>
                    {search
                      ? "Try another name or clear the search."
                      : "Use Add Visitor when someone new attends."}
                  </span>
                </div>
              )}
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
        {memberOpen && (
          <QuickAddMemberModal
            onClose={() => setMemberOpen(false)}
            onCreate={createQuickMember}
            onUseExisting={useExistingQuickMember}
          />
        )}
        {visitorOpen && (
          <VisitorModal
            settings={settings}
            onClose={() => setVisitorOpen(false)}
            onSave={async (input) => {
              if (!user) return;
              await addServiceVisitor(user, active.id, input);
              setVisitorOpen(false);
              await openService(active);
              await refreshLists();
            }}
          />
        )}
        {editingVisitor && (
          <VisitorModal
            settings={settings}
            existing={editingVisitor}
            onClose={() => setEditingVisitor(null)}
            onSave={async (input) => {
              if (!user) return;
              await editServiceVisitor(user, editingVisitor.id, input);
              setEditingVisitor(null);
              await openService(active);
            }}
          />
        )}
        {editOpen && (
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
                            <small className="pending-service-sync">
                              ● Waiting to sync
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

function QuickAddMemberModal({
  onClose,
  onCreate,
  onUseExisting,
}: {
  onClose: () => void;
  onCreate: (
    firstName: string,
    lastName: string,
    allowDuplicate?: boolean,
  ) => Promise<Person | undefined>;
  onUseExisting: (person: Person) => Promise<void>;
}) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [duplicate, setDuplicate] = useState<Person | undefined>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function create(allowDuplicate = false) {
    setSaving(true);
    setError("");
    try {
      const match = await onCreate(firstName, lastName, allowDuplicate);
      if (match) {
        setDuplicate(match);
        return;
      }
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not add member.");
    } finally {
      setSaving(false);
    }
  }

  async function handleUseExisting() {
    if (!duplicate) return;
    setSaving(true);
    setError("");
    try {
      await onUseExisting(duplicate);
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
            void create(false);
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
                  setDuplicate(undefined);
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
                  setDuplicate(undefined);
                }}
                required
              />
            </label>
          </div>
          {duplicate && (
            <div className="notice warning duplicate-member-warning">
              <strong>{duplicate.displayName} already exists.</strong>
              <span>
                {duplicate.isActive
                  ? "Use the existing member, or add another person with the same name."
                  : "This member is inactive. An administrator can reactivate and mark them present."}
              </span>
              <div>
                <button
                  className="button secondary"
                  type="button"
                  disabled={saving}
                  onClick={() => void handleUseExisting()}
                >
                  {duplicate.isActive
                    ? "Use existing and mark present"
                    : "Reactivate and mark present"}
                </button>
                <button
                  className="button subtle"
                  type="button"
                  disabled={saving}
                  onClick={() => void create(true)}
                >
                  Add another person
                </button>
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
            {!duplicate && (
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
