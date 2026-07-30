"use client";

import { useMemo, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { useToast } from "@/components/feedback/ToastProvider";
import type { Person } from "@/lib/domain";
import {
  mergeMembers,
  previewMemberMerge,
  type MemberMergePreview,
} from "@/lib/people/member-merge";
import { formatDate } from "@/lib/format/date-time";

export function MemberMergeModal({
  members,
  onClose,
  onCompleted,
}: {
  members: Person[];
  onClose: () => void;
  onCompleted: () => Promise<void>;
}) {
  const { user } = useAuth();
  const { showToast } = useToast();
  const available = useMemo(
    () =>
      members
        .filter((member) => !member.mergedIntoId)
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [members],
  );
  const [firstId, setFirstId] = useState("");
  const [secondId, setSecondId] = useState("");
  const [preview, setPreview] = useState<MemberMergePreview | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function review() {
    if (!user || !firstId || !secondId) return;
    try {
      setPreview(await previewMemberMerge(user, firstId, secondId));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The merge could not be previewed.");
    }
  }

  async function confirm() {
    if (!user || !preview || saving) return;
    setSaving(true);
    try {
      const result = await mergeMembers(
        user,
        preview.survivor.id,
        preview.duplicate.id,
      );
      await onCompleted();
      showToast(
        `${result.duplicate.displayName} was merged into ${result.survivor.displayName}.`,
        { key: `member-merged:${result.duplicate.id}:${result.survivor.id}` },
      );
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The members could not be merged.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <section
        className="modal member-merge-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="member-merge-title"
      >
        <div className="modal-heading">
          <div>
            <p className="eyebrow">Administrator utility</p>
            <h2 id="member-merge-title">Merge duplicate members</h2>
            <p>Compare two records before combining them. This cannot be undone automatically.</p>
          </div>
          <button className="icon-button" type="button" aria-label="Close member merge" onClick={onClose}>×</button>
        </div>

        {!preview ? (
          <div className="form-stack">
            <div className="form-grid">
              <label>
                First member
                <select
                  value={firstId}
                  onChange={(event) => {
                    setFirstId(event.target.value);
                    setPreview(null);
                    setError("");
                  }}
                >
                  <option value="">Choose a member</option>
                  {available.map((member) => (
                    <option key={member.id} value={member.id} disabled={member.id === secondId}>
                      {member.displayName} · {member.isActive ? "Active" : "Inactive"} · Added {formatDate(member.createdAt)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Possible duplicate
                <select
                  value={secondId}
                  onChange={(event) => {
                    setSecondId(event.target.value);
                    setPreview(null);
                    setError("");
                  }}
                >
                  <option value="">Choose a member</option>
                  {available.map((member) => (
                    <option key={member.id} value={member.id} disabled={member.id === firstId}>
                      {member.displayName} · {member.isActive ? "Active" : "Inactive"} · Added {formatDate(member.createdAt)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="notice warning">
              The oldest member record always survives, preserving its UUID and creation date.
            </div>
            {error && <div className="notice error" role="alert">{error}</div>}
            <div className="modal-actions">
              <button className="button subtle" type="button" onClick={onClose}>Cancel</button>
              <button className="button primary" type="button" disabled={!firstId || !secondId} onClick={() => void review()}>
                Preview merge
              </button>
            </div>
          </div>
        ) : (
          <div className="member-merge-preview">
            <div className="merge-direction" aria-label="Merge direction">
              <article>
                <span>Preserved record</span>
                <strong>{preview.survivor.displayName}</strong>
                <small>UUID {preview.survivor.id}</small>
                <small>Added {formatDate(preview.survivor.createdAt)}</small>
                <small>{preview.survivor.isActive ? "Active" : "Inactive"}</small>
                <small>{preview.survivor.email || "No email"} · {preview.survivor.phone || "No phone"}</small>
              </article>
              <span aria-hidden="true">←</span>
              <article>
                <span>Duplicate record</span>
                <strong>{preview.duplicate.displayName}</strong>
                <small>UUID {preview.duplicate.id}</small>
                <small>Added {formatDate(preview.duplicate.createdAt)}</small>
                <small>{preview.duplicate.isActive ? "Active" : "Inactive"}</small>
                <small>{preview.duplicate.email || "No email"} · {preview.duplicate.phone || "No phone"}</small>
              </article>
            </div>
            <dl className="merge-summary">
              <div><dt>Attendance history</dt><dd>{preview.attendanceToMove} attended services moved; {preview.overlappingServices} overlaps deduplicated</dd></div>
              <div><dt>Visitor history</dt><dd>{preview.visitorLinksToMove} linked visitor records retained</dd></div>
              <div>
                <dt>Contact information</dt>
                <dd>
                  {preview.mergedEmail || "No email"} · {preview.mergedPhone || "No phone"}
                  {preview.alternateContacts.length > 0
                    ? ` · ${preview.alternateContacts.length} alternate contact ${preview.alternateContacts.length === 1 ? "value" : "values"} preserved in Admin notes`
                    : ""}
                </dd>
              </div>
              <div><dt>Administrative notes</dt><dd>{preview.notesOutcome === "combined" ? "Both notes will be combined" : preview.notesOutcome === "none" ? "No notes" : "Existing notes will be retained"}</dd></div>
              <div><dt>Audit history</dt><dd>{preview.auditEntriesPreserved} existing entries remain linked and searchable</dd></div>
            </dl>
            <div className="notice warning" role="status">
              Confirming marks the duplicate record as merged. Attendance, visitor links, notes, contacts, and audit history remain attached to the preserved member.
            </div>
            {error && <div className="notice error" role="alert">{error}</div>}
            <div className="modal-actions">
              <button className="button subtle" type="button" disabled={saving} onClick={() => setPreview(null)}>Back</button>
              <button className="button primary" type="button" disabled={saving} onClick={() => void confirm()}>
                {saving ? "Merging…" : "Merge members"}
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
