"use client";

import { useMemo, useState } from "react";
import { Download, Printer, RefreshCw } from "lucide-react";
import { useAuth } from "@/components/auth/AuthProvider";
import { EmptyState } from "@/components/feedback/EmptyState";
import { LoadingSkeleton } from "@/components/feedback/LoadingSkeleton";
import {
  attendanceDateRange,
  loadCloudCustomAttendanceRangeDataset,
  loadCloudMonthlyAttendanceDataset,
  type MonthlyAttendanceDataset,
} from "@/lib/exports/monthly-attendance-data";
import {
  buildMonthlyAttendanceWorkbook,
  customAttendanceRangeFilename,
  downloadMonthlyAttendanceWorkbook,
  formatAttendanceDateRangeTitle,
  monthlyAttendanceFilename,
  needsLargeAttendanceRangeWarning,
} from "@/lib/exports/monthly-attendance-workbook";
import { summarizeServiceAttendance } from "@/lib/services/attendance-summary";

const months = Array.from({ length: 12 }, (_, index) =>
  new Intl.DateTimeFormat("en-CA", { month: "long", timeZone: "UTC" }).format(
    new Date(Date.UTC(2026, index, 1)),
  ),
);

function dateValue(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function serviceHeading(service: MonthlyAttendanceDataset["services"][number]) {
  const date = new Intl.DateTimeFormat("en-CA", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${service.serviceDate}T12:00:00Z`));
  const period = service.serviceTime
    ? Number(service.serviceTime.slice(0, 2)) < 12
      ? "AM"
      : "PM"
    : /morning/i.test(service.serviceType)
      ? "AM"
      : "PM";
  return `${date} ${period}`;
}

function personName(person: { firstName: string; lastName: string }) {
  return person.lastName
    ? `${person.lastName}, ${person.firstName}`
    : person.firstName;
}

export function AttendanceExportReport({ mode }: { mode: "monthly" | "range" }) {
  const { user } = useAuth();
  const now = new Date();
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [startDate, setStartDate] = useState(
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`,
  );
  const [endDate, setEndDate] = useState(dateValue(now));
  const [completedOnly, setCompletedOnly] = useState(true);
  const [dataset, setDataset] = useState<MonthlyAttendanceDataset>();
  const [previewKey, setPreviewKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const selectionKey = `${mode}:${year}:${month}:${startDate}:${endDate}:${completedOnly}`;
  const currentPreview = dataset && previewKey === selectionKey ? dataset : undefined;
  const title = currentPreview
    ? currentPreview.dateRange
      ? `Abundant Life Attendance - ${formatAttendanceDateRangeTitle(currentPreview.dateRange.startDate, currentPreview.dateRange.endDate)}`
      : `Abundant Life Attendance - ${months[currentPreview.month - 1]} ${currentPreview.year}`
    : "";
  const attendanceByService = useMemo(() => {
    const values = new Set<string>();
    for (const record of currentPreview?.attendance ?? []) {
      if (record.present) values.add(`${record.serviceId}:${record.personId}`);
    }
    return values;
  }, [currentPreview]);

  async function loadPreview() {
    if (!user || loading) return;
    if (!navigator.onLine) {
      setError("An internet connection is required to preview or export attendance.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const result =
        mode === "monthly"
          ? await loadCloudMonthlyAttendanceDataset(user, year, month, completedOnly)
          : await (async () => {
              attendanceDateRange(startDate, endDate);
              return loadCloudCustomAttendanceRangeDataset(
                user,
                startDate,
                endDate,
                completedOnly,
              );
            })();
      setDataset(result);
      setPreviewKey(selectionKey);
    } catch (caught) {
      setDataset(undefined);
      setError(
        caught instanceof Error
          ? caught.message
          : "The report data could not be loaded completely.",
      );
    } finally {
      setLoading(false);
    }
  }

  function exportWorkbook() {
    if (!currentPreview) return;
    const workbook = buildMonthlyAttendanceWorkbook(currentPreview);
    downloadMonthlyAttendanceWorkbook(
      workbook,
      mode === "monthly"
        ? monthlyAttendanceFilename(year, month)
        : customAttendanceRangeFilename(startDate, endDate),
    );
  }

  return (
    <section className="report-section attendance-export-report">
      <header className="report-section-heading">
        <div>
          <p className="eyebrow">Official attendance sheet</p>
          <h2>{mode === "monthly" ? "Monthly attendance" : "Custom date range"}</h2>
          <p>
            Preview the exact cloud data before creating the print-ready Excel workbook.
          </p>
        </div>
      </header>
      <div className="report-toolbar" aria-label="Attendance report options">
        {mode === "monthly" ? (
          <>
            <label>
              Month
              <select value={month} onChange={(event) => setMonth(Number(event.target.value))}>
                {months.map((name, index) => (
                  <option value={index + 1} key={name}>{name}</option>
                ))}
              </select>
            </label>
            <label>
              Year
              <input type="number" min="2000" max="2200" value={year} onChange={(event) => setYear(Number(event.target.value))} />
            </label>
          </>
        ) : (
          <>
            <label>
              Start date
              <input type="date" required value={startDate} onChange={(event) => setStartDate(event.target.value)} />
            </label>
            <label>
              End date
              <input type="date" required min={startDate} value={endDate} onChange={(event) => setEndDate(event.target.value)} />
            </label>
          </>
        )}
        <label>
          Services
          <select value={completedOnly ? "completed" : "all"} onChange={(event) => setCompletedOnly(event.target.value === "completed")}>
            <option value="completed">Completed only</option>
            <option value="all">Include open services</option>
          </select>
        </label>
        <button className="button primary" type="button" disabled={loading} onClick={() => void loadPreview()}>
          <RefreshCw aria-hidden="true" /> {loading ? "Loading…" : "Preview report"}
        </button>
      </div>
      {error && <div className="notice error" role="alert">{error}</div>}
      {loading ? (
        <LoadingSkeleton label="Loading authoritative attendance report" rows={5} />
      ) : !currentPreview ? (
        <EmptyState compact icon="▤" title="Choose a reporting period" message="Load a preview to verify the services and attendance before exporting." />
      ) : (
        <>
          <div className="report-actions no-print">
            <button className="button subtle" type="button" onClick={() => window.print()}><Printer aria-hidden="true" /> Print</button>
            <button className="button primary" type="button" onClick={exportWorkbook}><Download aria-hidden="true" /> Export Excel</button>
          </div>
          {mode === "range" &&
            needsLargeAttendanceRangeWarning(currentPreview.services.length) && (
              <div className="notice warning" role="status">
                This range contains {currentPreview.services.length} services.
                The workbook may be difficult to print on one page wide, but
                it can still be exported.
              </div>
            )}
          <div className="attendance-report-preview print-report" aria-label={title}>
            <h3>{title}</h3>
            <div className="report-table-scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Members</th>
                    {currentPreview.services.map((service) => <th scope="col" key={service.id}>{serviceHeading(service)}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {currentPreview.members.map((member) => (
                    <tr key={member.id}>
                      <th scope="row">{personName(member)}</th>
                      {currentPreview.services.map((service) => <td key={service.id}>{attendanceByService.has(`${service.id}:${member.id}`) ? "✓" : ""}</td>)}
                    </tr>
                  ))}
                  <tr className="report-section-row"><th scope="row">Visitors</th><td colSpan={currentPreview.services.length} /></tr>
                  {currentPreview.visitors.map((visitor) => (
                    <tr key={visitor.id}>
                      <th scope="row">{personName(visitor)}</th>
                      {currentPreview.services.map((service) => <td key={service.id}>{visitor.serviceId === service.id ? "✓" : ""}</td>)}
                    </tr>
                  ))}
                  <tr className="report-summary-row">
                    <th scope="row">Unnamed Visitors</th>
                    {currentPreview.services.map((service) => (
                      <td key={service.id}>{service.unnamedVisitorCount ?? 0}</td>
                    ))}
                  </tr>
                  <tr className="report-summary-row">
                    <th scope="row">Sunday School Kids</th>
                    {currentPreview.services.map((service) => (
                      <td key={service.id}>{service.sundaySchoolKidsCount ?? 0}</td>
                    ))}
                  </tr>
                  <tr className="report-summary-row">
                    <th scope="row">Total Attendance</th>
                    {currentPreview.services.map((service) => (
                      <td key={service.id}>
                        {summarizeServiceAttendance(
                          service,
                          currentPreview.attendance,
                          currentPreview.visitors,
                        ).totalPresent}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
