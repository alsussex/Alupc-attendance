"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
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
  getServiceAttendance,
  listActiveMembers,
  listServices,
  listServiceVisitors,
  saveService,
  setMemberAttendance,
} from "@/lib/repositories/attendance-repository";

function localDate() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function serviceTitle(service: ChurchService) {
  return service.customName || service.serviceType;
}

export function ServiceManager() {
  const { user } = useAuth();
  const [services, setServices] = useState<ChurchService[]>([]);
  const [members, setMembers] = useState<Person[]>([]);
  const [active, setActive] = useState<ChurchService | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [visitors, setVisitors] = useState<ServiceVisitor[]>([]);
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [visitorOpen, setVisitorOpen] = useState(false);
  const [message, setMessage] = useState("");

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
    void refreshLists();
  }, [refreshLists]);

  async function openService(service: ChurchService) {
    const [attendance, nextVisitors] = await Promise.all([
      getServiceAttendance(service.id),
      listServiceVisitors(service.id),
    ]);
    setActive(service);
    setSelected(new Set(attendance.filter((item) => item.present).map((item) => item.personId)));
    setVisitors(nextVisitors);
    setSearch("");
  }

  async function toggleMember(personId: string) {
    if (!user || !active) return;
    const present = !selected.has(personId);
    setSelected((current) => {
      const next = new Set(current);
      if (present) next.add(personId);
      else next.delete(personId);
      return next;
    });
    await setMemberAttendance(user, active.id, personId, present);
  }

  async function setStatus(status: "draft" | "completed") {
    if (!user || !active) return;
    const updated = await saveService(user, { ...active, status });
    setActive(updated);
    setMessage(status === "completed" ? "Service marked completed." : "Draft saved locally.");
    await refreshLists();
  }

  const filteredMembers = useMemo(() => {
    const normalized = search.toLocaleLowerCase().trim();
    return members.filter((member) => member.displayName.toLocaleLowerCase().includes(normalized));
  }, [members, search]);

  const total = countAttendance(
    selected,
    visitors.filter((visitor) => !visitor.savedAsMember).length,
  );

  if (active) {
    return (
      <div className="page-stack">
        <div className="service-topline">
          <button className="button subtle" type="button" onClick={() => setActive(null)}>← All services</button>
          <span className={`status-pill ${active.status}`}>{active.status}</span>
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
        {message && <div className="notice success" role="status">{message}</div>}
        <section className="panel attendance-panel">
          <div className="panel-toolbar">
            <label className="search-field">
              <span className="sr-only">Search attendance list</span>
              <span aria-hidden="true">⌕</span>
              <input type="search" placeholder="Search the member list" value={search} onChange={(event) => setSearch(event.target.value)} />
            </label>
            <button className="button secondary" type="button" onClick={() => setVisitorOpen(true)}>＋ Add visitor</button>
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
                  <span className="attendance-state">{checked ? "Present" : "Not selected"}</span>
                </label>
              );
            })}
          </div>
          {visitors.length > 0 && (
            <div className="visitor-summary">
              <h2>Visitors for this service</h2>
              {visitors.map((visitor) => (
                <div key={visitor.id}>
                  <strong>{visitor.displayName}</strong>
                  <span>{visitor.savedAsMember ? "Saved as member" : "This service only"}</span>
                </div>
              ))}
            </div>
          )}
        </section>
        <div className="sticky-actions">
          <span>{total} selected</span>
          <div>
            <button className="button subtle" type="button" onClick={() => void setStatus("draft")}>Save draft</button>
            <button className="button primary" type="button" onClick={() => void setStatus("completed")}>Mark completed</button>
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
              setMessage(`${input.firstName} added to this service.`);
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
      {createOpen && <CreateServiceModal onClose={() => setCreateOpen(false)} onCreated={async (service) => { setCreateOpen(false); await refreshLists(); await openService(service); }} />}
    </div>
  );

  function CreateServiceModal({ onClose, onCreated }: { onClose: () => void; onCreated: (service: ChurchService) => void }) {
    const [date, setDate] = useState(localDate());
    const [type, setType] = useState<ServiceType>("Sunday Morning");
    const [customName, setCustomName] = useState("");
    async function submit(event: FormEvent) {
      event.preventDefault();
      if (!user) return;
      const service = await saveService(user, { serviceDate: date, serviceType: type, customName, status: "draft" });
      onCreated(service);
    }
    return (
      <div className="modal-backdrop">
        <section className="modal" role="dialog" aria-modal="true" aria-labelledby="create-service-title">
          <div className="modal-heading"><div><p className="eyebrow">New attendance list</p><h2 id="create-service-title">Create a service</h2></div><button className="icon-button" aria-label="Close" type="button" onClick={onClose}>×</button></div>
          <form className="form-stack" onSubmit={submit}>
            <label>Service date<input type="date" value={date} onChange={(event) => setDate(event.target.value)} required /></label>
            <label>Service type<select value={type} onChange={(event) => setType(event.target.value as ServiceType)}>{SERVICE_TYPES.map((option) => <option key={option}>{option}</option>)}</select></label>
            {(type === "Special Service" || type === "Other") && <label>Custom service name <span className="optional">(optional)</span><input value={customName} onChange={(event) => setCustomName(event.target.value)} placeholder="e.g. Christmas Eve" /></label>}
            <div className="modal-actions"><button className="button subtle" type="button" onClick={onClose}>Cancel</button><button className="button primary">Create and take attendance</button></div>
          </form>
        </section>
      </div>
    );
  }
}

function VisitorModal({ onClose, onSave }: { onClose: () => void; onSave: (input: { firstName: string; lastName: string; saveAsMember: boolean }) => void }) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [saveAsMember, setSaveAsMember] = useState(false);
  function submit(event: FormEvent) {
    event.preventDefault();
    onSave({ firstName, lastName, saveAsMember });
  }
  return (
    <div className="modal-backdrop">
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="visitor-title">
        <div className="modal-heading"><div><p className="eyebrow">This service</p><h2 id="visitor-title">Add a visitor</h2></div><button className="icon-button" aria-label="Close" type="button" onClick={onClose}>×</button></div>
        <form className="form-stack" onSubmit={submit}>
          <div className="form-grid">
            <label>First name<input autoFocus value={firstName} onChange={(event) => setFirstName(event.target.value)} required /></label>
            <label>Last name<input value={lastName} onChange={(event) => setLastName(event.target.value)} required /></label>
          </div>
          <label className="choice-row">
            <input type="checkbox" checked={saveAsMember} onChange={(event) => setSaveAsMember(event.target.checked)} />
            <span><strong>Save as member for future services</strong><small>They will appear in future attendance lists.</small></span>
          </label>
          <div className="modal-actions"><button className="button subtle" type="button" onClick={onClose}>Cancel</button><button className="button primary">Add visitor</button></div>
        </form>
      </section>
    </div>
  );
}
