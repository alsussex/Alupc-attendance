"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import {
  loadDashboardSnapshot,
  type DashboardActivity,
  type DashboardService,
  type DashboardSnapshot,
} from "@/lib/dashboard/dashboard-data";
import { subscribeToDataChanges } from "@/lib/storage/data-events";
import { isAdmin } from "@/lib/auth/permissions";

const emptySnapshot: DashboardSnapshot = {
  churchName: "Abundant Life UPC",
  totalPeople: 0,
  servicesThisMonth: 0,
  attendanceThisMonth: 0,
  visitorsThisMonth: 0,
  averageAttendance: 0,
  services: [],
  activity: [],
};

const activityGlyphs: Record<DashboardActivity["type"], string> = {
  person: "P",
  service: "S",
  attendance: "✓",
  visitor: "V",
};

function greetingFor(date: Date) {
  const hour = date.getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function formatServiceDate(value: string) {
  return new Date(`${value}T12:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function groupServices(services: DashboardService[]) {
  const groups = new Map<string, DashboardService[]>();
  for (const service of services) {
    const key = service.serviceDate.slice(0, 7);
    groups.set(key, [...(groups.get(key) ?? []), service]);
  }
  return [...groups.entries()].map(([key, monthServices]) => {
    const [year, month] = key.split("-").map(Number);
    return {
      key,
      label: new Date(year, month - 1, 1).toLocaleDateString(undefined, {
        month: "long",
        year: "numeric",
      }),
      services: monthServices,
    };
  });
}

function relativeTime(timestamp: string, now: Date) {
  const difference = Math.max(0, now.getTime() - new Date(timestamp).getTime());
  const minutes = Math.floor(difference / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function Dashboard() {
  const { user } = useAuth();
  const [snapshot, setSnapshot] = useState(emptySnapshot);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expandedMonth, setExpandedMonth] = useState<
    string | null | undefined
  >(undefined);
  const now = useMemo(() => new Date(), []);

  const refresh = useCallback(async () => {
    if (!user) return;
    try {
      setSnapshot(await loadDashboardSnapshot(user.organizationId));
      setError("");
    } catch {
      setError("Saved dashboard information could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    const unsubscribe = subscribeToDataChanges(() => void refresh());
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [refresh]);

  const serviceGroups = useMemo(
    () => groupServices(snapshot.services),
    [snapshot.services],
  );

  const visibleMonth =
    expandedMonth === undefined ? serviceGroups[0]?.key : expandedMonth;

  const draft = snapshot.draftService;
  const visitorHref = draft
    ? `/services?service=${draft.id}&visitor=1`
    : "/services?new=1";
  const stats = [
    ["Total People", snapshot.totalPeople, "active members", "P"],
    ["Services This Month", snapshot.servicesThisMonth, "services", "S"],
    [
      "Attendance This Month",
      snapshot.attendanceThisMonth,
      "total attendance",
      "✓",
    ],
    ["Visitors This Month", snapshot.visitorsThisMonth, "welcomed", "V"],
    ["Average Attendance", snapshot.averageAttendance, "per service", "A"],
  ] as const;

  return (
    <div className="dashboard">
      <section className="dashboard-welcome" aria-labelledby="dashboard-title">
        <div>
          <p className="dashboard-date">
            <span>
              {now.toLocaleDateString(undefined, { weekday: "long" })}
            </span>
            {now.toLocaleDateString(undefined, {
              month: "long",
              day: "numeric",
              year: "numeric",
            })}
          </p>
          <p className="dashboard-greeting">{greetingFor(now)}</p>
          <h1 id="dashboard-title">{snapshot.churchName}</h1>
          <div className={draft ? "readiness active" : "readiness"}>
            <span className="readiness-dot" aria-hidden="true" />
            {draft ? "Attendance in progress" : "Ready for the next service"}
          </div>
        </div>
        <Link className="button dashboard-start" href="/services?new=1">
          <span aria-hidden="true">＋</span>
          Start New Service
        </Link>
      </section>

      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}

      {draft && (
        <Link
          className="resume-card"
          href={`/services?service=${draft.id}`}
          aria-label={`Resume attendance for ${draft.title}`}
        >
          <span className="resume-icon" aria-hidden="true">
            ✓
          </span>
          <span className="resume-copy">
            <span className="eyebrow">Draft service</span>
            <strong>Resume Attendance</strong>
            <small>
              {draft.title} · {formatServiceDate(draft.serviceDate)} ·{" "}
              {draft.attendanceTotal} selected
            </small>
          </span>
          <span className="resume-arrow" aria-hidden="true">
            →
          </span>
        </Link>
      )}

      <section aria-labelledby="quick-actions-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Get started</p>
            <h2 id="quick-actions-title">Quick actions</h2>
          </div>
          <span>Everything important is one tap away.</span>
        </div>
        <div className="quick-action-grid">
          <QuickAction
            href="/services?new=1"
            glyph="＋"
            label="Start New Service"
            description="Open a fresh attendance list"
            primary
          />
          <QuickAction
            href="/people"
            glyph="P"
            label="People"
            description="Manage the member directory"
          />
          <QuickAction
            href="/services"
            glyph="S"
            label="Services"
            description="Review attendance records"
          />
          <QuickAction
            href={visitorHref}
            glyph="V"
            label="Visitors"
            description="Add during a service"
          />
          <button
            className="quick-action placeholder-action"
            type="button"
            disabled
            aria-label="Reports, coming in a future stage"
          >
            <span className="quick-action-icon" aria-hidden="true">
              R
            </span>
            <span>
              <strong>Reports</strong>
              <small>Coming in a future stage</small>
            </span>
          </button>
          {isAdmin(user) && (
            <QuickAction
              href="/settings"
              glyph="⚙"
              label="Settings"
              description="Organization preferences"
            />
          )}
        </div>
      </section>

      <section className="dashboard-stats" aria-label="Attendance statistics">
        {stats.map(([label, value, hint, glyph]) => (
          <article className="stat-card" key={label}>
            <span className="stat-icon" aria-hidden="true">
              {glyph}
            </span>
            <span className="stat-copy">
              <span>{label}</span>
              <strong>{loading ? "—" : value.toLocaleString()}</strong>
              <small>{hint}</small>
            </span>
          </article>
        ))}
      </section>

      <div className="dashboard-columns">
        <section
          className="dashboard-panel"
          aria-labelledby="recent-services-title"
        >
          <div className="section-heading panel-heading">
            <div>
              <p className="eyebrow">Attendance history</p>
              <h2 id="recent-services-title">Recent services</h2>
            </div>
            {snapshot.services.length > 0 && (
              <Link href="/services">View all</Link>
            )}
          </div>

          {loading ? (
            <div className="dashboard-loading" role="status">
              Loading recent services…
            </div>
          ) : serviceGroups.length ? (
            <div className="service-months">
              {serviceGroups.map((group) => {
                const expanded = visibleMonth === group.key;
                return (
                  <article className="service-month" key={group.key}>
                    <button
                      className="month-toggle"
                      type="button"
                      aria-expanded={expanded}
                      aria-controls={`month-${group.key}`}
                      onClick={() =>
                        setExpandedMonth(expanded ? null : group.key)
                      }
                    >
                      <span aria-hidden="true">{expanded ? "⌄" : "›"}</span>
                      <strong>{group.label}</strong>
                      <small>
                        {group.services.length}{" "}
                        {group.services.length === 1 ? "service" : "services"}
                      </small>
                    </button>
                    <div
                      className={
                        expanded
                          ? "month-service-region expanded"
                          : "month-service-region"
                      }
                      id={`month-${group.key}`}
                      aria-hidden={!expanded}
                      inert={!expanded}
                    >
                      <div>
                        {group.services.map((service) => (
                          <Link
                            className="recent-service-row"
                            href={`/services?service=${service.id}`}
                            key={service.id}
                          >
                            <span className="recent-service-date">
                              {formatServiceDate(service.serviceDate)}
                            </span>
                            <span className="recent-service-copy">
                              <strong>{service.title}</strong>
                              <small>
                                {service.attendanceTotal} attending ·{" "}
                                {service.visitorCount}{" "}
                                {service.visitorCount === 1
                                  ? "visitor"
                                  : "visitors"}
                              </small>
                            </span>
                            <span className={`status-pill ${service.status}`}>
                              {service.status}
                            </span>
                          </Link>
                        ))}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="dashboard-empty">
              <div className="empty-calendar" aria-hidden="true">
                <span />
                <strong>✓</strong>
              </div>
              <h3>No services yet.</h3>
              <p>
                Create the first service and your member checklist will be ready.
              </p>
              <Link className="button primary large" href="/services?new=1">
                Create First Service
              </Link>
            </div>
          )}
        </section>

        <section className="dashboard-panel" aria-labelledby="activity-title">
          <div className="section-heading panel-heading">
            <div>
              <p className="eyebrow">Latest changes</p>
              <h2 id="activity-title">Recent activity</h2>
            </div>
          </div>
          {loading ? (
            <div className="dashboard-loading" role="status">
              Loading recent activity…
            </div>
          ) : snapshot.activity.length ? (
            <ol className="activity-timeline">
              {snapshot.activity.map((item) => (
                <li key={item.id}>
                  <span
                    className={`activity-icon ${item.type}`}
                    aria-hidden="true"
                  >
                    {activityGlyphs[item.type]}
                  </span>
                  <span>
                    <strong>{item.message}</strong>
                    <small>{relativeTime(item.timestamp, now)}</small>
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <div className="activity-empty">
              <span aria-hidden="true">✓</span>
              <strong>You’re ready to begin.</strong>
              <p>Member, service, and attendance updates will appear here.</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function QuickAction({
  href,
  glyph,
  label,
  description,
  primary = false,
}: {
  href: string;
  glyph: string;
  label: string;
  description: string;
  primary?: boolean;
}) {
  return (
    <Link
      className={primary ? "quick-action primary-action" : "quick-action"}
      href={href}
    >
      <span className="quick-action-icon" aria-hidden="true">
        {glyph}
      </span>
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
    </Link>
  );
}
