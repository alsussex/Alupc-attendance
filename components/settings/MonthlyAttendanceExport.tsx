"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { useToast } from "@/components/feedback/ToastProvider";
import {
  attendanceDateRange,
  loadCloudCustomAttendanceRangeDataset,
  loadCloudMonthlyAttendanceDataset,
} from "@/lib/exports/monthly-attendance-data";
import {
  buildMonthlyAttendanceWorkbook,
  customAttendanceRangeFilename,
  downloadMonthlyAttendanceWorkbook,
  monthlyAttendanceFilename,
  needsLargeAttendanceRangeWarning,
} from "@/lib/exports/monthly-attendance-workbook";

const monthNames = Array.from({ length: 12 }, (_, index) =>
  new Intl.DateTimeFormat("en-CA", { month: "long", timeZone: "UTC" }).format(
    new Date(Date.UTC(2026, index, 1)),
  ),
);

type ExportMode = "monthly" | "range";
const exportModeStorageKey = "church-attendance-export-mode";

function localDateValue(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function savedExportMode(): ExportMode {
  try {
    return window.localStorage.getItem(exportModeStorageKey) === "range"
      ? "range"
      : "monthly";
  } catch {
    return "monthly";
  }
}

export function MonthlyAttendanceExport() {
  const { user } = useAuth();
  const { showToast } = useToast();
  const now = new Date();
  const [open, setOpen] = useState(false);
  const [exportMode, setExportMode] = useState<ExportMode>("monthly");
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [startDate, setStartDate] = useState(
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`,
  );
  const [endDate, setEndDate] = useState(localDateValue(now));
  const [completedOnly, setCompletedOnly] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  const [largeRangeWarning, setLargeRangeWarning] = useState("");
  const [largeRangeConfirmationKey, setLargeRangeConfirmationKey] = useState<
    string | null
  >(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const exportingRef = useRef(false);

  useEffect(() => {
    exportingRef.current = exporting;
  }, [exporting]);

  function changeExportMode(mode: ExportMode) {
    setExportMode(mode);
    try {
      window.localStorage.setItem(exportModeStorageKey, mode);
    } catch {
      // A blocked preference store must not block exporting.
    }
  }

  const selectionKey = `${exportMode}:${year}:${month}:${startDate}:${endDate}:${completedOnly}`;
  const showLargeRangeWarning =
    largeRangeConfirmationKey === selectionKey && largeRangeWarning;

  useEffect(() => {
    if (!open) return;
    const openerElement = opener.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const timer = window.setTimeout(() => closeButton.current?.focus(), 0);
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !exportingRef.current) setOpen(false);
    };
    document.addEventListener("keydown", escape);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("keydown", escape);
      document.body.style.overflow = previousOverflow;
      window.setTimeout(() => openerElement?.focus(), 0);
    };
  }, [open]);

  async function exportWorkbook() {
    if (!user || exporting) return;
    setExporting(true);
    setError("");
    try {
      const dataset =
        exportMode === "monthly"
          ? await loadCloudMonthlyAttendanceDataset(
              user,
              year,
              month,
              completedOnly,
            )
          : await (async () => {
              attendanceDateRange(startDate, endDate);
              return loadCloudCustomAttendanceRangeDataset(
                user,
                startDate,
                endDate,
                completedOnly,
              );
            })();
      if (
        exportMode === "range" &&
        needsLargeAttendanceRangeWarning(dataset.services.length) &&
        largeRangeConfirmationKey !== selectionKey
      ) {
        setLargeRangeWarning(
          `This range contains ${dataset.services.length} services. The workbook may be difficult to print on one page wide. You can still export it.`,
        );
        setLargeRangeConfirmationKey(selectionKey);
        return;
      }
      const workbook = buildMonthlyAttendanceWorkbook(dataset);
      const filename =
        exportMode === "monthly"
          ? monthlyAttendanceFilename(year, month)
          : customAttendanceRangeFilename(startDate, endDate);
      downloadMonthlyAttendanceWorkbook(workbook, filename);
      setOpen(false);
      showToast("Attendance workbook exported.", {
        key: `attendance-export:${filename}`,
      });
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The attendance workbook could not be created.",
      );
    } finally {
      setExporting(false);
    }
  }

  return (
    <>
      <section className="panel settings-card monthly-attendance-export-card">
        <div className="settings-card-heading">
          <p className="eyebrow">Print-ready Excel</p>
          <h2>Attendance Export</h2>
          <p>
            Export a monthly or custom-range attendance sheet with one service
            per column.
          </p>
        </div>
        <div className="settings-action-row">
          <button
            ref={opener}
            className="button primary"
            type="button"
            onClick={() => {
              setError("");
              setLargeRangeWarning("");
              setLargeRangeConfirmationKey(null);
              setExportMode(savedExportMode());
              setOpen(true);
            }}
          >
            Export Attendance
          </button>
        </div>
      </section>

      {open && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !exporting) {
              setOpen(false);
            }
          }}
        >
          <section
            className="modal monthly-attendance-export-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="monthly-export-title"
          >
            <button
              ref={closeButton}
              className="modal-close"
              type="button"
              aria-label="Close attendance export"
              disabled={exporting}
              onClick={() => setOpen(false)}
            >
              ×
            </button>
            <p className="eyebrow">Excel workbook</p>
            <h2 id="monthly-export-title">Export Attendance</h2>
            <p className="muted">
              Choose a month or an inclusive custom date range. Exporting
              requires an internet connection and fully synchronized changes.
            </p>
            <label>
              Export type
              <select
                value={exportMode}
                disabled={exporting}
                onChange={(event) =>
                  changeExportMode(event.target.value as ExportMode)
                }
              >
                <option value="monthly">Monthly</option>
                <option value="range">Custom Date Range</option>
              </select>
            </label>
            <div className="form-grid monthly-export-fields">
              {exportMode === "monthly" ? (
                <>
                  <label>
                    Month
                    <select
                      value={month}
                      disabled={exporting}
                      onChange={(event) => setMonth(Number(event.target.value))}
                    >
                      {monthNames.map((name, index) => (
                        <option key={name} value={index + 1}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Year
                    <input
                      type="number"
                      min="2000"
                      max="2200"
                      value={year}
                      disabled={exporting}
                      onChange={(event) => setYear(Number(event.target.value))}
                    />
                  </label>
                </>
              ) : (
                <>
                  <label>
                    Start date
                    <input
                      type="date"
                      required
                      value={startDate}
                      disabled={exporting}
                      onChange={(event) => setStartDate(event.target.value)}
                    />
                  </label>
                  <label>
                    End date
                    <input
                      type="date"
                      required
                      min={startDate || undefined}
                      value={endDate}
                      disabled={exporting}
                      onChange={(event) => setEndDate(event.target.value)}
                    />
                  </label>
                </>
              )}
            </div>
            <label>
              Services
              <select
                value={completedOnly ? "completed" : "all"}
                disabled={exporting}
                onChange={(event) =>
                  setCompletedOnly(event.target.value === "completed")
                }
              >
                <option value="completed">Completed services only</option>
                <option value="all">Include open services</option>
              </select>
            </label>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            {showLargeRangeWarning && (
              <div className="notice warning" role="status">
                {showLargeRangeWarning}
              </div>
            )}
            <div className="modal-actions">
              <button
                className="button subtle"
                type="button"
                disabled={exporting}
                onClick={() => setOpen(false)}
              >
                Cancel
              </button>
              <button
                className="button primary"
                type="button"
                disabled={exporting}
                onClick={() => void exportWorkbook()}
              >
                {exporting
                  ? "Preparing workbook…"
                  : showLargeRangeWarning
                    ? "Export anyway"
                    : "Export .xlsx"}
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
