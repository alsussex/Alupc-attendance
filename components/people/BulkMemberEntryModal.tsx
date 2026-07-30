"use client";

import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import type { Person } from "@/lib/domain";
import {
  bulkMemberTotals,
  classifyBulkMemberRow,
  clearBulkMemberDraft,
  executeBulkMembers,
  loadBulkMemberDraft,
  parseBulkMembers,
  saveBulkMemberDraft,
  selectBulkMemberMatch,
  type BulkMemberExecutionResult,
  type BulkMemberRow,
} from "@/lib/people/bulk-member-entry";

function statusLabel(row: BulkMemberRow) {
  if (row.status === "ready" && row.decision === "create_separate") {
    return "Ready as separate person";
  }
  const labels: Record<BulkMemberRow["status"], string> = {
    ready: "Ready to add",
    existing: "Existing active member found",
    inactive: "Inactive member found",
    deleted: "Deleted member found",
    ambiguous: "Multiple possible matches",
    invalid: "Invalid line",
    processed: "Processed",
    failed: "Failed",
  };
  return labels[row.status];
}

function formatDate(value?: string | null) {
  if (!value) return "Not available";
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function BulkMemberEntryModal({
  candidates,
  lastAttendance,
  onClose,
  onCompleted,
}: {
  candidates: Person[];
  lastAttendance: Map<string, string>;
  onClose: () => void;
  onCompleted: () => Promise<void>;
}) {
  const { user } = useAuth();
  const restoredDraft = useMemo(
    () => (user ? loadBulkMemberDraft(user) : undefined),
    [user],
  );
  const [step, setStep] = useState<"entry" | "review">(
    restoredDraft?.step ?? "entry",
  );
  const [input, setInput] = useState(restoredDraft?.input ?? "");
  const [rows, setRows] = useState<BulkMemberRow[]>(
    restoredDraft?.rows ?? [],
  );
  const [processing, setProcessing] = useState(false);
  const [summary, setSummary] =
    useState<BulkMemberExecutionResult | null>(null);
  const totals = bulkMemberTotals(rows);

  useEffect(() => {
    if (!user) return;
    saveBulkMemberDraft(user, {
      input,
      rows,
      step,
      updatedAt: new Date().toISOString(),
    });
  }, [input, rows, step, user]);

  function review() {
    if (!user) return;
    setRows(parseBulkMembers(input, candidates, user.organizationId));
    setSummary(null);
    setStep("review");
  }

  function editName(
    rowId: string,
    field: "firstName" | "lastName",
    value: string,
  ) {
    if (!user) return;
    setRows((current) =>
      current.map((row) =>
        row.id === rowId
          ? classifyBulkMemberRow(
              { ...row, [field]: value },
              candidates,
              user.organizationId,
            )
          : row,
      ),
    );
    setSummary(null);
  }

  async function confirmMembers() {
    if (!user || processing) return;
    setProcessing(true);
    const result = await executeBulkMembers(user, rows);
    setRows(result.rows);
    setSummary((current) =>
      current
        ? {
            ...result,
            added: current.added + result.added,
            restored: current.restored + result.restored,
            skipped: current.skipped + result.skipped,
          }
        : result,
    );
    setProcessing(false);
    await onCompleted();
  }

  function finish() {
    if (user) clearBulkMemberDraft(user);
    onClose();
  }

  const unresolved = totals.requiringReview + totals.invalidLines;
  const operationLabel =
    totals.newMembers > 0 && totals.membersToRestore > 0
      ? `Add ${totals.newMembers} and Restore ${totals.membersToRestore} Members`
      : totals.membersToRestore > 0
        ? `Restore ${totals.membersToRestore} Members`
        : `Add ${totals.newMembers} Members`;

  return (
    <div className="modal-backdrop">
      <section
        className="modal bulk-member-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bulk-member-title"
      >
        <div className="modal-heading">
          <div>
            <p className="eyebrow">People directory</p>
            <h2 id="bulk-member-title">Add Multiple Members</h2>
            <p>
              {step === "entry"
                ? "Paste or type one church member per line."
                : "Review names and resolve matches before adding members."}
            </p>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Close bulk member entry"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        {step === "entry" ? (
          <div className="bulk-entry-step">
            <label className="bulk-member-input">
              Member names
              <textarea
                autoFocus
                rows={12}
                value={input}
                placeholder={"John Smith\nMary Jane Brown\nPeter"}
                onChange={(event) => setInput(event.target.value)}
              />
            </label>
            <div className="bulk-format-help">
              <strong>One person per line:</strong>
              <span>John Smith</span>
              <span>Mary Jane Brown</span>
              <span>Peter</span>
              <p>
                The first word is the first name. Everything after it is the
                last name. You can correct names during review. “Smith, John”
                is also accepted.
              </p>
            </div>
            {restoredDraft && input && (
              <div className="notice neutral" role="status">
                Your unfinished bulk-entry draft was restored on this device.
              </div>
            )}
            <div className="modal-actions">
              <button className="button subtle" type="button" onClick={onClose}>
                Save and close
              </button>
              <button
                className="button primary"
                type="button"
                disabled={!input.trim()}
                onClick={review}
              >
                Review Members
              </button>
            </div>
          </div>
        ) : (
          <div className="bulk-review-step">
            <div className="bulk-member-totals" aria-label="Bulk member totals">
              <span><strong>{totals.linesEntered}</strong> Lines</span>
              <span><strong>{totals.newMembers}</strong> New</span>
              <span><strong>{totals.existingMembers}</strong> Existing</span>
              <span><strong>{totals.membersToRestore}</strong> Restore</span>
              <span><strong>{totals.requiringReview}</strong> Review</span>
              <span><strong>{totals.invalidLines}</strong> Invalid</span>
            </div>

            {summary && (
              <div
                className={summary.failed ? "notice warning" : "notice success"}
                role="status"
              >
                <strong>Bulk member entry finished.</strong>
                <span>
                  {summary.added} added · {summary.restored} restored ·{" "}
                  {summary.skipped} existing skipped ·{" "}
                  {summary.notProcessed + summary.failed} not processed
                </span>
              </div>
            )}

            <div className="bulk-preview" role="table" aria-label="Member import preview">
              <div className="bulk-preview-header" role="row">
                <span role="columnheader">Original line</span>
                <span role="columnheader">First name</span>
                <span role="columnheader">Last name</span>
                <span role="columnheader">Result and action</span>
              </div>
              {rows.map((row) => (
                <div
                  className={`bulk-preview-row status-${row.status}`}
                  role="row"
                  key={row.id}
                >
                  <span className="bulk-original" role="cell">
                    <small>Original line</small>
                    {row.originalLine}
                  </span>
                  <label role="cell">
                    <span>First name</span>
                    <input
                      value={row.firstName}
                      disabled={row.status === "processed"}
                      aria-invalid={row.status === "invalid"}
                      onChange={(event) =>
                        editName(row.id, "firstName", event.target.value)
                      }
                    />
                  </label>
                  <label role="cell">
                    <span>Last name</span>
                    <input
                      value={row.lastName}
                      disabled={row.status === "processed"}
                      onChange={(event) =>
                        editName(row.id, "lastName", event.target.value)
                      }
                    />
                  </label>
                  <div className="bulk-row-result" role="cell">
                    <strong>{statusLabel(row)}</strong>
                    {row.error && <span className="field-error">{row.error}</span>}
                    {row.status === "existing" && row.matches[0] && (
                      <span>{row.matches[0].displayName} will be skipped.</span>
                    )}
                    {(row.status === "inactive" || row.status === "deleted") &&
                      row.matches[0] && (
                        <span>
                          Restore {row.matches[0].displayName} with the same
                          history and UUID.
                        </span>
                      )}
                    {row.status === "ambiguous" && (
                      <div className="bulk-match-actions">
                        <label>
                          Choose existing member
                          <select
                            value={row.selectedMatchId ?? ""}
                            onChange={(event) =>
                              setRows((current) =>
                                current.map((item) =>
                                  item.id === row.id
                                    ? selectBulkMemberMatch(
                                        item,
                                        event.target.value,
                                      )
                                    : item,
                                ),
                              )
                            }
                          >
                            <option value="">Select a member…</option>
                            {row.matches.map((match) => (
                              <option value={match.id} key={match.id}>
                                {match.displayName} ·{" "}
                                {match.deletedAt
                                  ? "Removed"
                                  : match.isActive
                                    ? "Active"
                                    : "Inactive"}{" "}
                                · Added {formatDate(match.createdAt)} · Last
                                attendance{" "}
                                {formatDate(lastAttendance.get(match.id))}
                              </option>
                            ))}
                          </select>
                        </label>
                        <button
                          className="button subtle"
                          type="button"
                          onClick={() =>
                            setRows((current) =>
                              current.map((item) =>
                                item.id === row.id
                                  ? {
                                      ...item,
                                      status: "ready",
                                      decision: "create_separate",
                                      selectedMatchId: undefined,
                                      error: undefined,
                                    }
                                  : item,
                              ),
                            )
                          }
                        >
                          Create separate person
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div className="modal-actions bulk-review-actions">
              <button
                className="button subtle"
                type="button"
                disabled={processing}
                onClick={() => setStep("entry")}
              >
                Back to names
              </button>
              {summary && summary.failed === 0 && unresolved === 0 ? (
                <button className="button primary" type="button" onClick={finish}>
                  Done
                </button>
              ) : (
                <button
                  className="button primary"
                  type="button"
                  disabled={
                    processing ||
                    unresolved > 0 ||
                    totals.newMembers + totals.membersToRestore === 0
                  }
                  onClick={() => void confirmMembers()}
                >
                  {processing
                    ? "Adding members…"
                    : summary?.failed
                      ? `Retry ${summary.failed} Failed Rows`
                      : operationLabel}
                </button>
              )}
            </div>
            {unresolved > 0 && (
              <p className="bulk-unresolved-message" role="alert">
                Resolve {unresolved} invalid or ambiguous{" "}
                {unresolved === 1 ? "line" : "lines"} before continuing.
              </p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
