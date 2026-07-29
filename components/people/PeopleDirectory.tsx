"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import type { Person } from "@/lib/domain";
import {
  findDuplicateMember,
  listActiveMembers,
  markMemberInactive,
  saveMember,
} from "@/lib/repositories/attendance-repository";

interface FormState {
  id?: string;
  firstName: string;
  lastName: string;
}

const emptyForm: FormState = { firstName: "", lastName: "" };

export function PeopleDirectory() {
  const { user } = useAuth();
  const [people, setPeople] = useState<Person[]>([]);
  const [query, setQuery] = useState("");
  const [form, setForm] = useState<FormState | null>(null);
  const [duplicate, setDuplicate] = useState<Person | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  const refresh = useCallback(async () => {
    if (user) setPeople(await listActiveMembers(user.organizationId));
  }, [user]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return people.filter((person) =>
      person.displayName.toLocaleLowerCase().includes(normalized),
    );
  }, [people, query]);

  async function submit(event: FormEvent, allowDuplicate = false) {
    event.preventDefault();
    if (!form || !user) return;
    const match = await findDuplicateMember(
      user.organizationId,
      `${form.firstName} ${form.lastName}`,
      form.id,
    );
    if (match && !allowDuplicate) {
      setDuplicate(match);
      return;
    }
    setSaving(true);
    await saveMember(user, form);
    setSaving(false);
    setForm(null);
    setDuplicate(null);
    setMessage(form.id ? "Member updated." : "Member added.");
    await refresh();
  }

  async function deactivate(person: Person) {
    if (!user || !confirm(`Mark ${person.displayName} inactive?`)) return;
    await markMemberInactive(user, person.id);
    setMessage(`${person.displayName} is now inactive.`);
    await refresh();
  }

  return (
    <div className="page-stack">
      <div className="page-heading with-action">
        <div>
          <p className="eyebrow">Directory</p>
          <h1>People</h1>
          <p>Active members appear automatically when you record a service.</p>
        </div>
        <button className="button primary" type="button" onClick={() => setForm(emptyForm)}>
          <span aria-hidden="true">＋</span> Add member
        </button>
      </div>

      {message && <div className="notice success" role="status">{message}</div>}

      <section className="panel">
        <div className="panel-toolbar">
          <label className="search-field">
            <span className="sr-only">Search members</span>
            <span aria-hidden="true">⌕</span>
            <input
              type="search"
              placeholder="Search members by name"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <span className="count-label">{filtered.length} active members</span>
        </div>

        <div className="person-list">
          {filtered.map((person) => (
            <article className="person-row" key={person.id}>
              <span className="avatar" aria-hidden="true">
                {person.firstName[0]}{person.lastName[0]}
              </span>
              <div className="person-name">
                <strong>{person.displayName}</strong>
                <span>Member</span>
              </div>
              <div className="row-actions">
                <button
                  className="button subtle"
                  type="button"
                  onClick={() =>
                    setForm({
                      id: person.id,
                      firstName: person.firstName,
                      lastName: person.lastName,
                    })
                  }
                >
                  Edit
                </button>
                <button className="button danger-text" type="button" onClick={() => void deactivate(person)}>
                  Mark inactive
                </button>
              </div>
            </article>
          ))}
          {!filtered.length && (
            <div className="empty-list">
              <h2>No members found</h2>
              <p>{query ? "Try a different search." : "Add your first member to begin."}</p>
            </div>
          )}
        </div>
      </section>

      {form && (
        <div className="modal-backdrop" role="presentation">
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="person-form-title">
            <div className="modal-heading">
              <div>
                <p className="eyebrow">People directory</p>
                <h2 id="person-form-title">{form.id ? "Edit member" : "Add a member"}</h2>
              </div>
              <button className="icon-button" aria-label="Close" type="button" onClick={() => setForm(null)}>×</button>
            </div>
            <form className="form-stack" onSubmit={submit}>
              <div className="form-grid">
                <label>
                  First name
                  <input
                    autoFocus
                    value={form.firstName}
                    onChange={(event) => setForm({ ...form, firstName: event.target.value })}
                    required
                  />
                </label>
                <label>
                  Last name
                  <input
                    value={form.lastName}
                    onChange={(event) => setForm({ ...form, lastName: event.target.value })}
                    required
                  />
                </label>
              </div>
              {duplicate && (
                <div className="notice warning" role="alert">
                  <strong>A similar active member already exists.</strong>
                  <span>{duplicate.displayName} is already in the directory. You may continue if these are different people.</span>
                </div>
              )}
              <div className="modal-actions">
                <button className="button subtle" type="button" onClick={() => setForm(null)}>Cancel</button>
                <button className="button primary" disabled={saving}>
                  {saving ? "Saving…" : duplicate ? "Add anyway" : "Save member"}
                </button>
              </div>
              {duplicate && (
                <button className="duplicate-confirm" type="button" onClick={(event) => void submit(event, true)}>
                  Confirm and save this separate person
                </button>
              )}
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
