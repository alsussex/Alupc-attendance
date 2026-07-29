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
  countAttendance,
  DEFAULT_APPLICATION_SETTINGS,
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
  listServices,
  listServiceVisitors,
  removeServiceVisitor,
  removeService,
  saveService,
  setServiceArchived,
  setMemberAttendance,
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
  filterAttendanceMembers,
  type AttendanceFilter,
} from "@/lib/services/attendance-view";

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

export function ServiceManager() {
  const { user } = useAuth();
  const { syncNow } = useSynchronization();
  const [services, setServices] = useState<ChurchService[]>([]);
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
  const [editingVisitor, setEditingVisitor] =
    useState<ServiceVisitor | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [serviceAction, setServiceAction] = useState<
    "draft" | "completed" | null
  >(null);
  const [actionFeedback, setActionFeedback] = useState("");
  const handledDashboardIntent = useRef("");
  const selectedRef = useRef<Set<string>>(new Set());

  const refreshLists = useCallback(async () => {
    if (!user) return;
    const [nextServices, settingsRecord] = await Promise.all([
      listServices(user.organizationId),
      getOrganizationSettings(user.organizationId),
    ]);
    const nextMembers = settingsRecord.settings.showInactiveInAttendance
      ? await listMembers(user.organizationId)
      : await listActiveMembers(user.organizationId);
    setServices(nextServices);
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
        settings.warnZeroAttendance && total === 0
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

  const total = countAttendance(
    selected,
    settings.includeVisitorsInTotal
      ? visitors.filter((visitor) => !visitor.savedAsMember).length
      : 0,
  );

  if (active) {
    return (
      <div className="page-stack">
        <div className="service-topline">
          <button className="button subtle" type="button" onClick={() => setActive(null)}>← All services</button>
          <div className="service-admin-actions">
            <span className={`status-pill ${active.status}`}>{active.status}</span>
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
        <div className="attendance-heading">
          <div>
            <p className="eyebrow">{formatChurchDate(active.serviceDate, settings)}</p>
            <h1>{serviceTitle(active)}</h1>
            <p>
              {active.serviceTime ? `${displayServiceTime(active.serviceTime)} · ` : ""}
              Select every person who attended. Changes save to this device immediately.
            </p>
          </div>
          {settings.showAttendanceTotals && (
            <div className="attendance-total" aria-live="polite">
              <strong>{total}</strong>
              <span>{total === 1 ? "person present" : "people present"}</span>
            </div>
          )}
        </div>
        {actionFeedback && (
          <div className="notice success" role="status">
            {actionFeedback}
          </div>
        )}
        <section className="panel attendance-panel">
          <div className="panel-toolbar">
            <label className="search-field">
              <span className="sr-only">Search attendance list</span>
              <span aria-hidden="true">⌕</span>
              <input type="search" placeholder="Search the member list" value={search} onChange={(event) => setSearch(event.target.value)} />
            </label>
            <button className="button secondary" type="button" onClick={() => setVisitorOpen(true)}>＋ Add visitor</button>
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
                    ? `All (${memberCounts.total})`
                    : filter === "present"
                      ? `Present (${memberCounts.present})`
                      : `Absent (${memberCounts.absent})`}
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
          {settings.showAttendanceTotals && (
            <div className="attendance-summary" aria-live="polite">
              {settings.showPresentCount && (
                <strong>{memberCounts.present} present</strong>
              )}
              {settings.showAbsentCount && (
                <span>{memberCounts.absent} absent</span>
              )}
              {settings.showTotalMemberCount && (
                <span>{memberCounts.total} total</span>
              )}
            </div>
          )}
          <div className="attendance-list">
            {filteredMembers.map((member) => {
              const checked = selected.has(member.id);
              return (
                <label className={checked ? "attendance-row selected" : "attendance-row"} key={member.id}>
                  <input type="checkbox" checked={checked} onChange={() => void toggleMember(member.id)} />
                  <span className="attendance-check" aria-hidden="true">{checked ? "✓" : ""}</span>
                  <span className="avatar">{member.firstName[0]}{member.lastName[0]}</span>
                  <span className="attendance-name">{member.displayName}</span>
                  <span className="attendance-state">{checked ? "Present" : "Absent"}</span>
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
          {visitors.length > 0 && (
            <div
              className={
                settings.showVisitorsSeparately
                  ? "visitor-summary"
                  : "visitor-summary integrated"
              }
            >
              {settings.showVisitorsSeparately && (
                <h2>{settings.visitorLabel}s for this service</h2>
              )}
              {visitors.map((visitor) => (
                <div className="visitor-row" key={visitor.id}>
                  <span className="visitor-name">
                    <strong>{visitor.displayName}</strong>
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
            </div>
          )}
        </section>
        <div className="sticky-actions">
          <span>{total} selected</span>
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
      <section className="service-grid">
        {services.map((service) => (
          <button className="service-card" type="button" key={service.id} onClick={() => void openService(service)}>
            <span className="service-date">
              <strong>{formatChurchDate(service.serviceDate, settings, { day: "2-digit" })}</strong>
              <span>{formatChurchDate(service.serviceDate, settings, { month: "short" })}</span>
            </span>
            <span className="service-card-copy">
              <strong>{serviceTitle(service)}</strong>
              <span>
                {formatChurchDate(service.serviceDate, settings, { weekday: "long", year: "numeric" })}
                {service.serviceTime ? ` · ${displayServiceTime(service.serviceTime)}` : ""}
              </span>
            </span>
            <span className={`status-pill ${service.status}`}>{service.status}</span>
            <span aria-hidden="true">›</span>
          </button>
        ))}
        {!services.length && (
          <section className="empty-panel full-width">
            <span className="empty-icon" aria-hidden="true">＋</span>
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
