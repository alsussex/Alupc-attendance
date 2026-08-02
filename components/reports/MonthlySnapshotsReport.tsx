"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, Eye, FileCheck2, Printer, RefreshCw } from "lucide-react";
import { useAuth } from "@/components/auth/AuthProvider";
import { EmptyState } from "@/components/feedback/EmptyState";
import { useConfirmation } from "@/components/feedback/ConfirmationProvider";
import { LoadingSkeleton } from "@/components/feedback/LoadingSkeleton";
import { useToast } from "@/components/feedback/ToastProvider";
import { isAdmin } from "@/lib/auth/permissions";
import {
  loadCloudMonthlyAttendanceDataset,
  type MonthlyAttendanceDataset,
} from "@/lib/exports/monthly-attendance-data";
import {
  buildMonthlyAttendanceWorkbook,
  downloadMonthlyAttendanceWorkbook,
  monthlyAttendanceFilename,
} from "@/lib/exports/monthly-attendance-workbook";
import { formatDateTime } from "@/lib/format/date-time";
import {
  buildMonthlySnapshotPayload,
  finalizeMonthlySnapshot,
  listMonthlySnapshots,
  snapshotToAttendanceDataset,
  type MonthlyAttendanceSnapshot,
  type MonthlySnapshotPayload,
} from "@/lib/reports/monthly-snapshots";
import { getOrganization } from "@/lib/repositories/settings-repository";

const months = Array.from({ length: 12 }, (_, index) =>
  new Intl.DateTimeFormat("en-CA", { month: "long", timeZone: "UTC" }).format(
    new Date(Date.UTC(2026, index, 1)),
  ),
);

function displayName(person: { firstName: string; lastName: string }) {
  return person.lastName
    ? `${person.lastName}, ${person.firstName}`
    : person.firstName;
}

function SnapshotTable({ payload }: { payload: MonthlySnapshotPayload }) {
  const attended = useMemo(
    () =>
      new Set(
        payload.members.flatMap((member) =>
          member.attendedServiceIds.map(
            (serviceId) => `${serviceId}:${member.id}`,
          ),
        ),
      ),
    [payload],
  );
  return (
    <div className="attendance-report-preview snapshot-preview print-report">
      <h3>
        {payload.churchName} Attendance — {months[payload.month - 1]} {payload.year}
      </h3>
      <div className="report-table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Members</th>
              {payload.services.map((service) => (
                <th scope="col" key={service.id}>{service.heading}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {payload.members.map((member) => (
              <tr key={member.id}>
                <th scope="row">{displayName(member)}</th>
                {payload.services.map((service) => (
                  <td key={service.id}>
                    {attended.has(`${service.id}:${member.id}`) ? "✓" : ""}
                  </td>
                ))}
              </tr>
            ))}
            <tr className="report-section-row">
              <th scope="row">Visitors</th>
              <td colSpan={payload.services.length} />
            </tr>
            {payload.visitors.map((visitor) => (
              <tr key={visitor.id}>
                <th scope="row">{displayName(visitor)}</th>
                {payload.services.map((service) => (
                  <td key={service.id}>{visitor.serviceId === service.id ? "✓" : ""}</td>
                ))}
              </tr>
            ))}
            <tr className="report-summary-row">
              <th scope="row">Unnamed Visitors</th>
              {payload.services.map((service) => <td key={service.id}>{service.unnamedVisitors}</td>)}
            </tr>
            <tr className="report-summary-row">
              <th scope="row">Sunday School Kids</th>
              {payload.services.map((service) => <td key={service.id}>{service.sundaySchoolKids}</td>)}
            </tr>
            <tr className="report-summary-row">
              <th scope="row">Total Attendance</th>
              {payload.services.map((service) => <td key={service.id}>{service.totalAttendance}</td>)}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function MonthlySnapshotsReport() {
  const { user } = useAuth();
  const confirm = useConfirmation();
  const { showToast } = useToast();
  const now = new Date();
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [notes, setNotes] = useState("");
  const [snapshots, setSnapshots] = useState<MonthlyAttendanceSnapshot[]>([]);
  const [preview, setPreview] = useState<MonthlyAttendanceDataset>();
  const [previewPayload, setPreviewPayload] = useState<MonthlySnapshotPayload>();
  const [selected, setSelected] = useState<MonthlyAttendanceSnapshot>();
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const admin = isAdmin(user);
  const selectedMonthStart = `${year}-${String(month).padStart(2, "0")}-01`;
  const existingForSelection = snapshots.find(
    (snapshot) => snapshot.monthStart === selectedMonthStart,
  );

  const refresh = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      setSnapshots(await listMonthlySnapshots(user));
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Snapshots could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  async function loadPreview() {
    if (!user || !admin || working) return;
    setWorking(true);
    setError("");
    try {
      const existing = snapshots.find(
        (snapshot) => snapshot.monthStart === `${year}-${String(month).padStart(2, "0")}-01`,
      );
      if (existing) {
        setSelected(existing);
        setPreview(undefined);
        setPreviewPayload(undefined);
        throw new Error("A finalized snapshot already exists for this month.");
      }
      const [dataset, organization] = await Promise.all([
        loadCloudMonthlyAttendanceDataset(user, year, month, true),
        getOrganization(user.organizationId),
      ]);
      setPreview(dataset);
      setPreviewPayload(
        buildMonthlySnapshotPayload(
          dataset,
          organization?.name || "Abundant Life UPC",
        ),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The snapshot preview could not be loaded.");
    } finally {
      setWorking(false);
    }
  }

  async function finalize() {
    if (!user || !admin || !preview || working) return;
    const approved = await confirm({
      title: "Finalize this monthly snapshot?",
      message:
        "This creates an immutable official record for the selected month. It cannot be silently replaced or edited later.",
      confirmLabel: "Finalize Monthly Snapshot",
    });
    if (!approved) return;
    setWorking(true);
    setError("");
    try {
      const snapshot = await finalizeMonthlySnapshot(
        user,
        preview.year,
        preview.month,
        notes,
      );
      setSnapshots((current) =>
        [snapshot, ...current].sort((a, b) => b.monthStart.localeCompare(a.monthStart)),
      );
      setSelected(snapshot);
      setPreview(undefined);
      setPreviewPayload(undefined);
      setNotes("");
      showToast("Monthly attendance snapshot finalized.", {
        key: `snapshot-finalized:${snapshot.id}`,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The snapshot could not be finalized.");
    } finally {
      setWorking(false);
    }
  }

  function exportSnapshot(snapshot: MonthlyAttendanceSnapshot) {
    const dataset = snapshotToAttendanceDataset(snapshot);
    downloadMonthlyAttendanceWorkbook(
      buildMonthlyAttendanceWorkbook(dataset, new Date(snapshot.finalizedAt)),
      monthlyAttendanceFilename(dataset.year, dataset.month),
    );
  }

  return (
    <section className="report-section monthly-snapshots-report">
      <header className="report-section-heading">
        <div>
          <p className="eyebrow">Official records</p>
          <h2>Monthly attendance snapshots</h2>
          <p>Finalized snapshots preserve names and attendance exactly as recorded at finalization.</p>
        </div>
      </header>

      {admin && (
        <section className="snapshot-admin-tools no-print" aria-label="Admin snapshot controls">
          <div>
            <h3>Finalize a month</h3>
            <p>Authoritative Supabase data is checked before an immutable record is created.</p>
            <span className={`snapshot-status ${existingForSelection ? "finalized" : previewPayload ? "draft" : "not-created"}`}>
              {existingForSelection
                ? "Finalized"
                : previewPayload
                  ? "Draft preview"
                  : "Not created"}
            </span>
          </div>
          <div className="report-toolbar">
            <label>Month<select value={month} onChange={(event) => { setMonth(Number(event.target.value)); setPreview(undefined); setPreviewPayload(undefined); }}>{months.map((name, index) => <option key={name} value={index + 1}>{name}</option>)}</select></label>
            <label>Year<input type="number" min="2000" max="2200" value={year} onChange={(event) => { setYear(Number(event.target.value)); setPreview(undefined); setPreviewPayload(undefined); }} /></label>
            <button className="button primary" type="button" disabled={working} onClick={() => void loadPreview()}><RefreshCw aria-hidden="true" /> {working ? "Loading…" : "Preview month"}</button>
          </div>
          {previewPayload && (
            <div className="snapshot-finalize-controls">
              <label>Optional snapshot notes<textarea maxLength={2000} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Explain unusual services or attendance circumstances" /></label>
              <button className="button primary" type="button" disabled={working} onClick={() => void finalize()}><FileCheck2 aria-hidden="true" /> Finalize Monthly Snapshot</button>
            </div>
          )}
        </section>
      )}

      {error && <div className="notice error" role="alert">{error}</div>}
      {previewPayload && <><div className="snapshot-status draft">Draft preview — not finalized</div><SnapshotTable payload={previewPayload} /></>}

      <section className="snapshot-list-section">
        <div className="report-section-heading"><div><h3>Finalized snapshots</h3><p>Newest month first. Finalized records are read-only.</p></div></div>
        {loading ? <LoadingSkeleton label="Loading monthly snapshots" rows={4} /> : snapshots.length === 0 ? <EmptyState compact icon="▤" title="No finalized snapshots" message={admin ? "Preview and finalize the first official month above." : "An administrator has not finalized a monthly snapshot yet."} /> : (
          <div className="report-table-scroll"><table className="report-data-table"><thead><tr><th>Month</th><th>Finalized</th><th>Finalized by</th><th>Services</th><th>Total attendance</th><th className="no-print">Actions</th></tr></thead><tbody>{snapshots.map((snapshot) => <tr key={snapshot.id}><th scope="row">{months[snapshot.payload.month - 1]} {snapshot.payload.year}</th><td>{formatDateTime(snapshot.finalizedAt)}</td><td>{snapshot.finalizedByName}</td><td>{snapshot.serviceCount}</td><td>{snapshot.totalAttendance}</td><td className="no-print"><div className="report-row-actions"><button className="text-button" type="button" onClick={() => setSelected(snapshot)}><Eye aria-hidden="true" /> View</button><button className="text-button" type="button" onClick={() => { setSelected(snapshot); window.setTimeout(() => window.print(), 0); }}><Printer aria-hidden="true" /> Print</button><button className="text-button" type="button" onClick={() => exportSnapshot(snapshot)}><Download aria-hidden="true" /> Export Excel</button></div></td></tr>)}</tbody></table></div>
        )}
      </section>

      {selected && (
        <section className="snapshot-selected-view">
          <div className="report-section-heading"><div><p className="eyebrow">Finalized · Version {selected.snapshotVersion}</p><h3>{months[selected.payload.month - 1]} {selected.payload.year}</h3><p>Finalized by {selected.finalizedByName} on {formatDateTime(selected.finalizedAt)}</p></div><div className="report-actions no-print"><button className="button subtle" type="button" onClick={() => window.print()}><Printer aria-hidden="true" /> Print</button><button className="button primary" type="button" onClick={() => exportSnapshot(selected)}><Download aria-hidden="true" /> Export Excel</button></div></div>
          {selected.notes && <div className="notice">Snapshot notes: {selected.notes}</div>}
          <SnapshotTable payload={selected.payload} />
        </section>
      )}
    </section>
  );
}
