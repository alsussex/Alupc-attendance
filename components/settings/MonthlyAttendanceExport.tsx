"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { useToast } from "@/components/feedback/ToastProvider";
import {
  ensureMonthlyAttendanceCache,
  loadMonthlyAttendanceDataset,
} from "@/lib/exports/monthly-attendance-data";
import {
  buildMonthlyAttendanceWorkbook,
  downloadMonthlyAttendanceWorkbook,
  monthlyAttendanceFilename,
} from "@/lib/exports/monthly-attendance-workbook";

const monthNames = Array.from({ length: 12 }, (_, index) =>
  new Intl.DateTimeFormat("en-CA", { month: "long", timeZone: "UTC" }).format(
    new Date(Date.UTC(2026, index, 1)),
  ),
);

export function MonthlyAttendanceExport() {
  const { user } = useAuth();
  const { showToast } = useToast();
  const now = new Date();
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [completedOnly, setCompletedOnly] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  const closeButton = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const exportingRef = useRef(false);

  useEffect(() => {
    exportingRef.current = exporting;
  }, [exporting]);

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
      await ensureMonthlyAttendanceCache(user, year, month);
      const dataset = await loadMonthlyAttendanceDataset(
        user,
        year,
        month,
        completedOnly,
      );
      const workbook = buildMonthlyAttendanceWorkbook(dataset);
      const filename = monthlyAttendanceFilename(year, month);
      downloadMonthlyAttendanceWorkbook(workbook, filename);
      setOpen(false);
      showToast("Monthly attendance workbook exported.", {
        key: `monthly-attendance:${year}-${month}`,
      });
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The monthly attendance workbook could not be created.",
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
          <h2>Monthly Attendance</h2>
          <p>
            Export the church’s member and visitor attendance sheet with one
            service per column.
          </p>
        </div>
        <div className="settings-action-row">
          <button
            ref={opener}
            className="button primary"
            type="button"
            onClick={() => {
              setError("");
              setOpen(true);
            }}
          >
            Export Monthly Attendance
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
              aria-label="Close monthly attendance export"
              disabled={exporting}
              onClick={() => setOpen(false)}
            >
              ×
            </button>
            <p className="eyebrow">Excel workbook</p>
            <h2 id="monthly-export-title">Export Monthly Attendance</h2>
            <p className="muted">
              Choose the month and whether open services should be included.
              Incomplete months are verified online before the workbook is
              created.
            </p>
            <div className="form-grid monthly-export-fields">
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
                {exporting ? "Preparing workbook…" : "Export .xlsx"}
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
