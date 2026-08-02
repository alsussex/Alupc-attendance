"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  CheckCircle2,
  ClipboardCheck,
  FileChartColumn,
  Play,
  Plus,
  Settings,
  UserRoundPlus,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import { useAuth } from "@/components/auth/AuthProvider";
import {
  loadDashboardSnapshot,
  type DashboardActivity,
  type DashboardService,
  type DashboardSnapshot,
} from "@/lib/dashboard/dashboard-data";
import { subscribeToDataChanges } from "@/lib/storage/data-events";
import { isAdmin } from "@/lib/auth/permissions";

export const emptyDashboardSnapshot: DashboardSnapshot = {
  churchName: "Abundant Life UPC",
  totalPeople: 0,
  servicesThisMonth: 0,
  attendanceThisMonth: 0,
  visitorsThisMonth: 0,
  averageAttendance: 0,
  services: [],
  activity: [],
};

const activityIcons: Record<DashboardActivity["type"], LucideIcon> = {
  person: UsersRound,
  service: CalendarDays,
  attendance: ClipboardCheck,
  visitor: UserRoundPlus,
};

function greetingFor(date: Date) {
  const hour = date.getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function dateKey(date: Date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function formatServiceDate(value: string, long = false) {
  return new Date(`${value}T12:00:00`).toLocaleDateString(undefined, {
    month: long ? "long" : "short",
    day: "numeric",
    year: long ? "numeric" : undefined,
  });
}

function formatServiceTime(value?: string) {
  if (!value) return null;
  const [hours, minutes] = value.split(":").map(Number);
  return new Date(2026, 0, 1, hours, minutes).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
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
  const [snapshot, setSnapshot] = useState(emptyDashboardSnapshot);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

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

  return (
    <DashboardView
      snapshot={snapshot}
      loading={loading}
      error={error}
      isAdministrator={isAdmin(user)}
    />
  );
}

export function DashboardView({
  snapshot,
  loading,
  error = "",
  isAdministrator,
  currentDate,
}: {
  snapshot: DashboardSnapshot;
  loading: boolean;
  error?: string;
  isAdministrator: boolean;
  currentDate?: Date;
}) {
  const now = useMemo(() => currentDate ?? new Date(), [currentDate]);
  const [expandedMonth, setExpandedMonth] = useState<
    string | null | undefined
  >(undefined);
  const serviceGroups = useMemo(
    () => groupServices(snapshot.services),
    [snapshot.services],
  );
  const visibleMonth =
    expandedMonth === undefined ? serviceGroups[0]?.key : expandedMonth;
  const draft = snapshot.draftService;
  const today = dateKey(now);
  const nextService = useMemo(
    () =>
      [...snapshot.services]
        .filter((service) => service.serviceDate >= today)
        .sort(
          (left, right) =>
            left.serviceDate.localeCompare(right.serviceDate) ||
            (left.serviceTime ?? "").localeCompare(right.serviceTime ?? ""),
        )[0],
    [snapshot.services, today],
  );
  const visitorHref = draft
    ? `/services?service=${draft.id}&visitor=1`
    : "/services?new=1";
  const stats = [
    {
      label: "Total members",
      value: snapshot.totalPeople,
      hint: "active members",
      icon: UsersRound,
      tone: "neutral",
    },
    {
      label: "Attendance this month",
      value: snapshot.attendanceThisMonth,
      hint: "members and visitors",
      icon: ClipboardCheck,
      tone: "current",
    },
    {
      label: "Visitors this month",
      value: snapshot.visitorsThisMonth,
      hint: "people welcomed",
      icon: UserRoundPlus,
      tone: "neutral",
    },
    {
      label: "Services this month",
      value: snapshot.servicesThisMonth,
      hint: "church services",
      icon: CalendarDays,
      tone: "neutral",
    },
    {
      label: "Average attendance",
      value: snapshot.averageAttendance,
      hint: "per service",
      icon: Activity,
      tone: "neutral",
    },
    {
      label: "Draft services",
      value: snapshot.services.filter((service) => service.status === "draft")
        .length,
      hint: "ready to continue",
      icon: ClipboardCheck,
      tone: "draft",
    },
  ] as const;

  return (
    <div className="dashboard dashboard-redesign">
      <section className="dashboard-hero" aria-labelledby="dashboard-title">
        <div className="dashboard-hero-copy">
          <p className="dashboard-greeting">{greetingFor(now)}</p>
          <h1 id="dashboard-title">{snapshot.churchName} Attendance</h1>
          <p className="dashboard-full-date">
            {now.toLocaleDateString(undefined, {
              weekday: "long",
              month: "long",
              day: "numeric",
              year: "numeric",
            })}
          </p>
          <div className="dashboard-hero-actions">
            <Link className="button primary dashboard-primary-action" href="/services?new=1">
              <Plus aria-hidden="true" />
              New service
            </Link>
            <Link className="button dashboard-secondary-action" href="/services">
              View services
            </Link>
          </div>
        </div>

        {loading ? (
          <HeroSkeleton />
        ) : nextService ? (
          <Link
            className="dashboard-focus-card"
            href={`/services?service=${nextService.id}`}
            aria-label={`Open ${nextService.title}`}
          >
            <span className="dashboard-focus-kicker">
              {nextService.serviceDate === today
                ? "Today’s service"
                : "Next service"}
            </span>
            <strong>{nextService.title}</strong>
            <span>
              {formatServiceDate(nextService.serviceDate, true)}
              {formatServiceTime(nextService.serviceTime)
                ? ` · ${formatServiceTime(nextService.serviceTime)}`
                : ""}
            </span>
            <span className={`dashboard-focus-status ${nextService.status}`}>
              {nextService.status === "draft" ? "Ready to continue" : "Completed"}
            </span>
            <span className="dashboard-focus-arrow" aria-hidden="true">
              <ArrowRight />
            </span>
          </Link>
        ) : (
          <div className="dashboard-focus-card empty-focus">
            <span className="dashboard-focus-icon" aria-hidden="true">
              <CheckCircle2 />
            </span>
            <span className="dashboard-focus-kicker">You’re all set</span>
            <strong>Ready for the next service</strong>
            <span>Create a service whenever you’re ready to begin.</span>
          </div>
        )}
      </section>

      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}

      {draft && !loading && (
        <Link
          className="dashboard-resume"
          href={`/services?service=${draft.id}`}
          aria-label={`Resume attendance for ${draft.title}`}
        >
          <span className="dashboard-resume-icon" aria-hidden="true">
            <Play />
          </span>
          <span className="dashboard-resume-copy">
            <small>Attendance in progress</small>
            <strong>Resume {draft.title}</strong>
            <span>
              {formatServiceDate(draft.serviceDate)} ·{" "}
              {draft.attendanceTotal} present
            </span>
          </span>
          <span className="dashboard-resume-action">
            Resume attendance <ArrowRight aria-hidden="true" />
          </span>
        </Link>
      )}

      <section aria-labelledby="quick-actions-title">
        <DashboardSectionHeading
          eyebrow="Shortcuts"
          title="Quick actions"
          id="quick-actions-title"
        />
        <div className="dashboard-action-grid">
          <QuickAction
            href="/services?new=1"
            icon={Plus}
            label="New service"
            description="Start taking attendance"
            primary
          />
          <QuickAction
            href="/people"
            icon={UsersRound}
            label="Members"
            description="View and manage people"
          />
          <QuickAction
            href={visitorHref}
            icon={UserRoundPlus}
            label="Visitors"
            description="Add to the current service"
          />
          <QuickAction
            href="/services"
            icon={CalendarDays}
            label="Services"
            description="Browse attendance history"
          />
          <button
            className="dashboard-action-card unavailable"
            type="button"
            disabled
            aria-label="Reports, coming in a future release"
          >
            <span className="dashboard-action-icon" aria-hidden="true">
              <FileChartColumn />
            </span>
            <span>
              <strong>Reports</strong>
              <small>Coming in a future release</small>
            </span>
          </button>
          {isAdministrator && (
            <QuickAction
              href="/settings"
              icon={Settings}
              label="Settings"
              description="Church preferences"
            />
          )}
        </div>
      </section>

      <section aria-labelledby="overview-title">
        <DashboardSectionHeading
          eyebrow="At a glance"
          title="Attendance overview"
          id="overview-title"
        />
        <div className="dashboard-metric-grid" aria-label="Attendance statistics">
          {loading
            ? Array.from({ length: 6 }, (_, index) => (
                <MetricSkeleton key={index} />
              ))
            : stats.map((stat) => <MetricCard key={stat.label} {...stat} />)}
        </div>
      </section>

      <div className="dashboard-content-grid">
        <section
          className="dashboard-surface dashboard-services-surface"
          aria-labelledby="recent-services-title"
        >
          <DashboardPanelHeading
            eyebrow="Attendance history"
            title="Recent services"
            id="recent-services-title"
            action={
              snapshot.services.length > 0 ? (
                <Link href="/services">View all services</Link>
              ) : null
            }
          />

          {loading ? (
            <RecentServicesSkeleton />
          ) : serviceGroups.length ? (
            <div className="dashboard-service-months">
              {serviceGroups.map((group) => {
                const expanded = visibleMonth === group.key;
                return (
                  <article className="dashboard-service-month" key={group.key}>
                    <button
                      className="dashboard-month-toggle"
                      type="button"
                      aria-expanded={expanded}
                      aria-controls={`month-${group.key}`}
                      onClick={() =>
                        setExpandedMonth(expanded ? null : group.key)
                      }
                    >
                      <span>
                        <strong>{group.label}</strong>
                        <small>
                          {group.services.length}{" "}
                          {group.services.length === 1 ? "service" : "services"}
                        </small>
                      </span>
                      <span className="dashboard-month-chevron" aria-hidden="true">
                        {expanded ? "−" : "+"}
                      </span>
                    </button>
                    {expanded && (
                      <div
                        className="dashboard-service-card-grid"
                        id={`month-${group.key}`}
                      >
                        {group.services.map((service) => (
                          <ServiceCard
                            key={service.id}
                            service={service}
                            now={now}
                          />
                        ))}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="dashboard-empty-state">
              <span className="dashboard-empty-icon" aria-hidden="true">
                <CalendarDays />
              </span>
              <h3>No services yet</h3>
              <p>
                Create your first service to begin tracking attendance.
              </p>
              <Link className="button primary large" href="/services?new=1">
                Create first service
              </Link>
            </div>
          )}
        </section>

        <section
          className="dashboard-surface dashboard-activity-surface"
          aria-labelledby="activity-title"
        >
          <DashboardPanelHeading
            eyebrow="Latest changes"
            title="Recent activity"
            id="activity-title"
          />
          {loading ? (
            <ActivitySkeleton />
          ) : snapshot.activity.length ? (
            <ol className="dashboard-activity-list">
              {snapshot.activity.map((item) => (
                <li key={item.id}>
                  <span
                    className={`dashboard-activity-icon ${item.type}`}
                    aria-hidden="true"
                  >
                    {(() => {
                      const Icon = activityIcons[item.type];
                      return <Icon />;
                    })()}
                  </span>
                  <span>
                    <strong>{item.message}</strong>
                    <small>{relativeTime(item.timestamp, now)}</small>
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <div className="dashboard-activity-empty">
              <span aria-hidden="true"><CheckCircle2 /></span>
              <strong>You’re ready to begin</strong>
              <p>Member, service, and attendance updates will appear here.</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function DashboardSectionHeading({
  eyebrow,
  title,
  id,
}: {
  eyebrow: string;
  title: string;
  id: string;
}) {
  return (
    <div className="dashboard-section-heading">
      <p>{eyebrow}</p>
      <h2 id={id}>{title}</h2>
    </div>
  );
}

function DashboardPanelHeading({
  eyebrow,
  title,
  id,
  action,
}: {
  eyebrow: string;
  title: string;
  id: string;
  action?: React.ReactNode;
}) {
  return (
    <header className="dashboard-panel-heading">
      <div>
        <p>{eyebrow}</p>
        <h2 id={id}>{title}</h2>
      </div>
      {action}
    </header>
  );
}

function QuickAction({
  href,
  icon: Icon,
  label,
  description,
  primary = false,
}: {
  href: string;
  icon: LucideIcon;
  label: string;
  description: string;
  primary?: boolean;
}) {
  return (
    <Link
      className={
        primary
          ? "dashboard-action-card primary"
          : "dashboard-action-card"
      }
      href={href}
    >
      <span className="dashboard-action-icon" aria-hidden="true">
        <Icon />
      </span>
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
      <span className="dashboard-action-arrow" aria-hidden="true">
        <ArrowRight />
      </span>
    </Link>
  );
}

function MetricCard({
  label,
  value,
  hint,
  icon: Icon,
  tone,
}: {
  label: string;
  value: number;
  hint: string;
  icon: LucideIcon;
  tone: "neutral" | "current" | "draft";
}) {
  return (
    <article className={`dashboard-metric-card ${tone}`}>
      <span className="dashboard-metric-icon" aria-hidden="true">
        <Icon />
      </span>
      <strong>{value.toLocaleString()}</strong>
      <span>{label}</span>
      <small>{hint}</small>
    </article>
  );
}

function ServiceCard({
  service,
  now,
}: {
  service: DashboardService;
  now: Date;
}) {
  return (
    <Link
      className="dashboard-service-card"
      href={`/services?service=${service.id}`}
      aria-label={`Open ${service.title}, ${service.status}`}
    >
      <div className="dashboard-service-card-top">
        <span className={`dashboard-service-status ${service.status}`}>
          <span aria-hidden="true" />
          {service.status === "draft" ? "Draft" : "Completed"}
        </span>
        <span className="dashboard-service-arrow" aria-hidden="true">
          <ArrowUpRight />
        </span>
      </div>
      <strong>{service.title}</strong>
      <span className="dashboard-service-date">
        {formatServiceDate(service.serviceDate, true)}
        {formatServiceTime(service.serviceTime)
          ? ` · ${formatServiceTime(service.serviceTime)}`
          : ""}
      </span>
      <div className="dashboard-service-stats">
        <span>
          <strong>{service.attendanceTotal}</strong>
          <small>Attendance</small>
        </span>
        <span>
          <strong>{service.visitorCount}</strong>
          <small>Visitors</small>
        </span>
      </div>
      <small className="dashboard-service-updated">
        Updated {relativeTime(service.updatedAt, now)}
      </small>
    </Link>
  );
}

function SkeletonLine({ className = "" }: { className?: string }) {
  return <span className={`dashboard-skeleton ${className}`} aria-hidden="true" />;
}

function HeroSkeleton() {
  return (
    <div
      className="dashboard-focus-card dashboard-focus-skeleton"
      role="status"
      aria-label="Loading church dashboard"
    >
      <SkeletonLine className="short" />
      <SkeletonLine className="title" />
      <SkeletonLine />
      <SkeletonLine className="pill" />
    </div>
  );
}

function MetricSkeleton() {
  return (
    <article className="dashboard-metric-card skeleton-card" aria-hidden="true">
      <SkeletonLine className="metric-icon" />
      <SkeletonLine className="metric-number" />
      <SkeletonLine />
      <SkeletonLine className="short" />
    </article>
  );
}

function RecentServicesSkeleton() {
  return (
    <div
      className="dashboard-card-skeleton-grid"
      role="status"
      aria-label="Loading recent services"
    >
      {[0, 1].map((item) => (
        <div className="dashboard-service-card skeleton-card" key={item}>
          <SkeletonLine className="pill" />
          <SkeletonLine className="title" />
          <SkeletonLine />
          <SkeletonLine className="block" />
        </div>
      ))}
    </div>
  );
}

function ActivitySkeleton() {
  return (
    <div
      className="dashboard-activity-skeleton"
      role="status"
      aria-label="Loading recent activity"
    >
      {[0, 1, 2, 3].map((item) => (
        <div key={item}>
          <SkeletonLine className="activity-dot" />
          <span>
            <SkeletonLine />
            <SkeletonLine className="short" />
          </span>
        </div>
      ))}
    </div>
  );
}
