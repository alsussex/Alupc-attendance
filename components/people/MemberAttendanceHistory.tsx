"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { EmptyState } from "@/components/feedback/EmptyState";
import { LoadingSkeleton } from "@/components/feedback/LoadingSkeleton";
import { formatDate, formatTime } from "@/lib/format/date-time";
import {
  filterMemberAttendanceHistory,
  loadMemberAttendanceHistory,
  serviceTypeAttendanceTotals,
  summarizeMemberAttendance,
  type AttendanceHistoryPeriod,
  type MemberAttendanceHistoryEntry,
} from "@/lib/people/attendance-history";
import { subscribeToDataChanges } from "@/lib/storage/data-events";

const PAGE_SIZE = 20;

const periodOptions: Array<{
  value: AttendanceHistoryPeriod;
  label: string;
}> = [
  { value: "all", label: "All time" },
  { value: "year", label: "This year" },
  { value: "month", label: "This month" },
  { value: "last_30_days", label: "Last 30 days" },
];

export function MemberAttendanceHistory({
  organizationId,
  personId,
  memberName,
  currentDate,
}: {
  organizationId: string;
  personId: string;
  memberName: string;
  currentDate?: Date;
}) {
  const [entries, setEntries] = useState<MemberAttendanceHistoryEntry[]>([]);
  const [period, setPeriod] = useState<AttendanceHistoryPeriod>("all");
  const [serviceType, setServiceType] = useState("all");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const now = useMemo(() => currentDate ?? new Date(), [currentDate]);

  const refresh = useCallback(async () => {
    try {
      const history = await loadMemberAttendanceHistory(
        organizationId,
        personId,
      );
      setEntries(history);
      setError("");
    } catch {
      setError(
        "Attendance history could not be loaded from this device. Please try again.",
      );
    } finally {
      setLoading(false);
    }
  }, [organizationId, personId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    const unsubscribe = subscribeToDataChanges(() => void refresh());
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [refresh]);

  const summary = useMemo(
    () => summarizeMemberAttendance(entries, now),
    [entries, now],
  );
  const serviceTypes = useMemo(
    () => [...new Set(entries.map((entry) => entry.serviceType))].sort(),
    [entries],
  );
  const periodEntries = useMemo(
    () => filterMemberAttendanceHistory(entries, period, "all", now),
    [entries, now, period],
  );
  const filtered = useMemo(
    () =>
      filterMemberAttendanceHistory(entries, period, serviceType, now),
    [entries, now, period, serviceType],
  );
  const typeTotals = useMemo(
    () => serviceTypeAttendanceTotals(periodEntries),
    [periodEntries],
  );
  const visibleEntries = filtered.slice(0, visibleCount);

  if (loading) {
    return <LoadingSkeleton label={`Loading attendance for ${memberName}`} />;
  }

  return (
    <div className="member-attendance-history">
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}

      <section
        className="member-attendance-stats"
        aria-label={`${memberName} attendance summary`}
      >
        <article
          aria-label={`Last attended: ${formatDate(summary.lastAttendedDate, "Not yet")}`}
        >
          <span>Last attended</span>
          <strong>{formatDate(summary.lastAttendedDate, "Not yet")}</strong>
        </article>
        <article aria-label={`Total services attended: ${summary.totalServices}`}>
          <span>Total services</span>
          <strong>{summary.totalServices}</strong>
        </article>
        <article aria-label={`Attendance this month: ${summary.thisMonth}`}>
          <span>This month</span>
          <strong>{summary.thisMonth}</strong>
        </article>
        <article aria-label={`Attendance this year: ${summary.thisYear}`}>
          <span>This year</span>
          <strong>{summary.thisYear}</strong>
        </article>
      </section>

      <div className="member-attendance-filters">
        <label>
          Time period
          <select
            value={period}
            onChange={(event) => {
              setPeriod(event.target.value as AttendanceHistoryPeriod);
              setVisibleCount(PAGE_SIZE);
            }}
          >
            {periodOptions.map((option) => (
              <option value={option.value} key={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Service type
          <select
            value={serviceType}
            onChange={(event) => {
              setServiceType(event.target.value);
              setVisibleCount(PAGE_SIZE);
            }}
          >
            <option value="all">All service types</option>
            {serviceTypes.map((type) => (
              <option value={type} key={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
      </div>

      {typeTotals.length > 0 && (
        <section className="member-service-type-totals">
          <h3>Services attended by type</h3>
          <div>
            {typeTotals.map((item) => (
              <span key={item.serviceType}>
                {item.serviceType} <strong>{item.total}</strong>
              </span>
            ))}
          </div>
        </section>
      )}

      <section className="member-attendance-timeline">
        <div className="member-attendance-timeline-heading">
          <div>
            <h3>Recent attendance</h3>
            <p>
              {filtered.length} service{filtered.length === 1 ? "" : "s"} in
              this view
            </p>
          </div>
        </div>
        {visibleEntries.length === 0 ? (
          <EmptyState
            compact
            icon="○"
            title="No attendance in this view"
            message={
              entries.length === 0
                ? `${memberName} has no recorded attendance yet.`
                : "Try a different time period or service type."
            }
          />
        ) : (
          <>
            <ol aria-label={`${memberName} attendance, newest first`}>
              {visibleEntries.map((entry) => (
                <li key={entry.attendanceId}>
                  <a href={`/services?service=${encodeURIComponent(entry.serviceId)}`}>
                    <span className="attendance-history-date">
                      {formatDate(entry.serviceDate)}
                    </span>
                    <span className="attendance-history-service">
                      <strong>{entry.serviceName}</strong>
                      <small>
                        {entry.serviceType}
                        {entry.serviceTime
                          ? ` · ${formatTime(entry.serviceTime)}`
                          : ""}
                      </small>
                    </span>
                    <span className={`status-pill ${entry.serviceStatus}`}>
                      {entry.serviceStatus === "completed"
                        ? "Completed"
                        : "Draft"}
                    </span>
                    <span aria-hidden="true">›</span>
                  </a>
                </li>
              ))}
            </ol>
            {visibleCount < filtered.length && (
              <button
                className="button subtle member-attendance-load-more"
                type="button"
                onClick={() =>
                  setVisibleCount((count) => count + PAGE_SIZE)
                }
              >
                Load more attendance
              </button>
            )}
          </>
        )}
      </section>
    </div>
  );
}
