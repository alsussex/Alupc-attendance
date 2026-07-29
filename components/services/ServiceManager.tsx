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
import {
  attendanceCounts,
  filterAttendanceMembers,
  type AttendanceFilter,
} from "@/lib/services/attendance-view";

function localDate() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function serviceTitle(service: ChurchService) {
  return service.customName || service.serviceType;
}

export function ServiceManager() {
  const { user } = useAuth();
  const { syncNow } = useSynchronization();
  const [services, setServices] = useState<ChurchService[]>([]);
  const [members, setMembers] = useState<Person[]>([]);
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
    const [nextServices, nextMembers] = await Promise.all([
      listServices(user.organizationId),
      listActiveMembers(user.organizationId),
    ]);
    setServices(nextServices);
    setMembers(nextMembers);
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
      members,
      selected,
      attendanceFilter,
      search,
    );
  }, [attendanceFilter, members, search, selected]);

  const memberCounts = useMemo(
    () => attendanceCounts(members, selected),
    [members, selected],
  );

  const total = countAttendance(
    selected,
    visitors.filter((visitor) => !visitor.savedAsMember).length,
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
                    if (!confirm(`Archive ${serviceTitle(active)}?`)) return;
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
            <p className="eyebrow">{new Date(`${active.serviceDate}T12:00:00`).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</p>
            <h1>{serviceTitle(active)}</h1>
            <p>Select every person who attended. Changes save to this device immediately.</p>
          </div>
          <div className="attendance-total" aria-live="polite">
            <strong>{total}</strong>
            <span>{total === 1 ? "person present" : "people present"}</span>
          </div>
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
          <div className="attendance-summary" aria-live="polite">
            <strong>{memberCounts.present} present</strong>
            <span>{memberCounts.absent} absent</span>
            <span>{memberCounts.total} total</span>
          </div>
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
            <div className="visitor-summary">
              <h2>Visitors for this service</h2>
              {visitors.map((visitor) => (
                <div className="visitor-row" key={visitor.id}>
                  <span className="visitor-name">
                    <strong>{visitor.displayName}</strong>
                    <small>{visitor.savedAsMember ? "Saved as member" : "This service only"}</small>
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
          </div>
        </div>
        {visitorOpen && (
          <VisitorModal
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
              <strong>{new Date(`${service.serviceDate}T12:00:00`).toLocaleDateString(undefined, { day: "2-digit" })}</strong>
              <span>{new Date(`${service.serviceDate}T12:00:00`).toLocaleDateString(undefined, { month: "short" })}</span>
            </span>
            <span className="service-card-copy">
              <strong>{serviceTitle(service)}</strong>
              <span>{new Date(`${service.serviceDate}T12:00:00`).toLocaleDateString(undefined, { weekday: "long", year: "numeric" })}</span>
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
      {createOpen && <ServiceModal onClose={() => setCreateOpen(false)} onSaved={async (service) => { setCreateOpen(false); await refreshLists(); await openService(service); }} />}
    </div>
  );

  function ServiceModal({ onClose, onSaved, existing }: { onClose: () => void; onSaved: (service: ChurchService) => void; existing?: ChurchService }) {
    const [date, setDate] = useState(existing?.serviceDate ?? localDate());
    const [type, setType] = useState<ServiceType>(existing?.serviceType ?? "Sunday Morning");
    const [customName, setCustomName] = useState(existing?.customName ?? "");
    async function submit(event: FormEvent) {
      event.preventDefault();
      if (!user) return;
      const service = await saveService(user, {
        id: existing?.id,
        serviceDate: date,
        serviceType: type,
        customName,
        status: existing?.status ?? "draft",
      });
      onSaved(service);
    }
    return (
      <div className="modal-backdrop">
        <section className="modal" role="dialog" aria-modal="true" aria-labelledby="create-service-title">
          <div className="modal-heading"><div><p className="eyebrow">{existing ? "Service details" : "New attendance list"}</p><h2 id="create-service-title">{existing ? "Edit service" : "Create a service"}</h2></div><button className="icon-button" aria-label="Close" type="button" onClick={onClose}>×</button></div>
          <form className="form-stack" onSubmit={submit}>
            <label>Service date<input type="date" value={date} onChange={(event) => setDate(event.target.value)} required /></label>
            <label>Service type<select value={type} onChange={(event) => setType(event.target.value as ServiceType)}>{SERVICE_TYPES.map((option) => <option key={option}>{option}</option>)}</select></label>
            {(type === "Special Service" || type === "Other") && <label>Custom service name <span className="optional">(optional)</span><input value={customName} onChange={(event) => setCustomName(event.target.value)} placeholder="e.g. Christmas Eve" /></label>}
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
}: {
  onClose: () => void;
  onSave: (input: {
    firstName: string;
    lastName: string;
    saveAsMember: boolean;
  }) => void;
  existing?: ServiceVisitor;
}) {
  const [firstName, setFirstName] = useState(existing?.firstName ?? "");
  const [lastName, setLastName] = useState(existing?.lastName ?? "");
  const [saveAsMember, setSaveAsMember] = useState(
    existing?.savedAsMember ?? false,
  );
  function submit(event: FormEvent) {
    event.preventDefault();
    onSave({ firstName, lastName, saveAsMember });
  }
  return (
    <div className="modal-backdrop">
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="visitor-title">
        <div className="modal-heading"><div><p className="eyebrow">This service</p><h2 id="visitor-title">{existing ? "Edit visitor" : "Add a visitor"}</h2></div><button className="icon-button" aria-label="Close" type="button" onClick={onClose}>×</button></div>
        <form className="form-stack" onSubmit={submit}>
          <div className="form-grid">
            <label>First name<input autoFocus value={firstName} onChange={(event) => setFirstName(event.target.value)} required /></label>
            <label>Last name<input value={lastName} onChange={(event) => setLastName(event.target.value)} required /></label>
          </div>
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
