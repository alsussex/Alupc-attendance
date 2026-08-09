"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  Clock3,
  Plus,
} from "lucide-react";
import { useAuth } from "@/components/auth/AuthProvider";
import {
  loadDashboardSnapshot,
  type DashboardService,
  type DashboardSnapshot,
} from "@/lib/dashboard/dashboard-data";
import { subscribeToDataChanges } from "@/lib/storage/data-events";
import { isAdmin } from "@/lib/auth/permissions";
import { formatTime } from "@/lib/format/date-time";
import type { UserRole } from "@/lib/domain";

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

type FeaturedState = "upcoming" | "in-progress" | "completed";

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

function serviceMoment(service: DashboardService) {
  return `${service.serviceDate}T${service.serviceTime || "00:00"}`;
}

function newestFirst(left: DashboardService, right: DashboardService) {
  return (
    serviceMoment(right).localeCompare(serviceMoment(left)) ||
    right.updatedAt.localeCompare(left.updatedAt)
  );
}

function oldestFirst(left: DashboardService, right: DashboardService) {
  return (
    serviceMoment(left).localeCompare(serviceMoment(right)) ||
    left.updatedAt.localeCompare(right.updatedAt)
  );
}

function isUpcoming(service: DashboardService, now: Date) {
  const today = dateKey(now);
  if (service.serviceDate !== today) return service.serviceDate > today;
  if (!service.serviceTime) return false;
  const [hours, minutes] = service.serviceTime.split(":").map(Number);
  return hours * 60 + minutes > now.getHours() * 60 + now.getMinutes();
}

export function selectFeaturedService(
  services: DashboardService[],
  now: Date,
): DashboardService | undefined {
  const today = dateKey(now);
  const open = services.filter((service) => service.status === "draft");
  const openToday = open
    .filter((service) => service.serviceDate === today)
    .sort(oldestFirst)[0];
  if (openToday) return openToday;

  const completedToday = services
    .filter(
      (service) =>
        service.status === "completed" && service.serviceDate === today,
    )
    .sort(newestFirst)[0];
  if (completedToday) return completedToday;

  const nextOpen = open
    .filter((service) => service.serviceDate > today)
    .sort(oldestFirst)[0];
  if (nextOpen) return nextOpen;

  const unfinished = open
    .filter((service) => service.serviceDate < today)
    .sort(newestFirst)[0];
  if (unfinished) return unfinished;

  return services
    .filter((service) => service.status === "completed")
    .sort(newestFirst)[0];
}

function featuredState(service: DashboardService, now: Date): FeaturedState {
  if (service.status === "completed") return "completed";
  return isUpcoming(service, now) ? "upcoming" : "in-progress";
}

function equivalentIdentity(service: DashboardService) {
  const serviceType = service.serviceType?.trim().toLocaleLowerCase();
  if (serviceType === "special service") {
    const customName = service.customName?.trim().toLocaleLowerCase();
    return customName ? `special:${customName}` : null;
  }
  return serviceType || service.title.trim().toLocaleLowerCase();
}

export function findPreviousEquivalentService(
  featured: DashboardService,
  services: DashboardService[],
): DashboardService | undefined {
  const identity = equivalentIdentity(featured);
  if (!identity) return undefined;
  return services
    .filter(
      (service) =>
        service.id !== featured.id &&
        service.status === "completed" &&
        serviceMoment(service) < serviceMoment(featured) &&
        equivalentIdentity(service) === identity,
    )
    .sort(newestFirst)[0];
}

function formatServiceDate(value: string, includeWeekday = true) {
  return new Date(`${value}T12:00:00`).toLocaleDateString(undefined, {
    weekday: includeWeekday ? "long" : undefined,
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function shortServiceDate(value: string) {
  return new Date(`${value}T12:00:00`).toLocaleDateString(undefined, {
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
      displayName={user?.displayName}
      role={user?.role}
    />
  );
}

export function DashboardView(props: {
  snapshot: DashboardSnapshot;
  loading: boolean;
  error?: string;
  isAdministrator: boolean;
  displayName?: string;
  role?: UserRole;
  currentDate?: Date;
}) {
  const {
    snapshot,
    loading,
    error = "",
    currentDate,
    displayName,
    role,
    isAdministrator,
  } = props;
  const now = useMemo(() => currentDate ?? new Date(), [currentDate]);
  const featured = useMemo(
    () => selectFeaturedService(snapshot.services, now),
    [snapshot.services, now],
  );
  const state = featured ? featuredState(featured, now) : undefined;
  const previous = useMemo(
    () =>
      featured
        ? findPreviousEquivalentService(featured, snapshot.services)
        : undefined,
    [featured, snapshot.services],
  );
  const upNext = useMemo(
    () =>
      featured
        ? snapshot.services
            .filter(
              (service) =>
                service.id !== featured.id &&
                service.status === "draft" &&
                serviceMoment(service) > serviceMoment(featured),
            )
            .sort(oldestFirst)[0]
        : undefined,
    [featured, snapshot.services],
  );
  const recentServices = useMemo(
    () =>
      [...snapshot.services]
        .filter((service) => service.id !== featured?.id)
        .sort(newestFirst)
        .slice(0, 3),
    [featured?.id, snapshot.services],
  );
  const accountName = displayName?.trim();
  const roleLabel =
    role === "admin" || (!role && isAdministrator)
      ? "Admin"
      : "Attendance Taker";

  return (
    <main className="dashboard dashboard-home" aria-labelledby="dashboard-title">
      <header className="dashboard-home-heading">
        <div>
          <h1 id="dashboard-title">
            {greetingFor(now)}{accountName ? `, ${accountName}` : ""}
          </h1>
          <p className="dashboard-home-role">{roleLabel}</p>
          <p className="dashboard-home-date">
            {now.toLocaleDateString(undefined, {
              weekday: "long",
              month: "long",
              day: "numeric",
              year: "numeric",
            })}
          </p>
        </div>
        <Link
          className="button primary dashboard-create-service"
          href="/services?new=1"
        >
          <Plus aria-hidden="true" />
          Create new service
        </Link>
      </header>

      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}

      <div className="dashboard-home-layout">
        <section
          className="dashboard-current-service"
          aria-labelledby="current-service-title"
        >
          {loading ? (
            <CurrentServiceSkeleton />
          ) : featured && state ? (
            <CurrentService
              service={featured}
              state={state}
              previous={previous}
            />
          ) : (
            <NoService />
          )}
        </section>

        <aside
          className="dashboard-recent-services"
          aria-labelledby="recent-services-title"
        >
          <div className="dashboard-recent-heading">
            <h2 id="recent-services-title">Recent services</h2>
            {!loading && snapshot.services.length > 0 && (
              <Link href="/services">View all</Link>
            )}
          </div>
          {loading ? (
            <RecentServicesSkeleton />
          ) : recentServices.length ? (
            <div className="dashboard-recent-list">
              {recentServices.map((service) => (
                <RecentServiceRow key={service.id} service={service} />
              ))}
            </div>
          ) : (
            <p className="dashboard-recent-empty">
              Completed and open services will appear here.
            </p>
          )}
        </aside>
      </div>

      {!loading && upNext && (
        <section className="dashboard-up-next" aria-labelledby="up-next-title">
          <span className="dashboard-up-next-icon" aria-hidden="true">
            <CalendarDays />
          </span>
          <div className="dashboard-up-next-copy">
            <p>Up next</p>
            <h2 id="up-next-title">{upNext.title}</h2>
            <span>
              {formatServiceDate(upNext.serviceDate)}
              {upNext.serviceTime ? ` · ${formatTime(upNext.serviceTime)}` : ""}
            </span>
          </div>
          <Link className="button subtle" href="/services">
            View schedule
            <ArrowRight aria-hidden="true" />
          </Link>
        </section>
      )}
    </main>
  );
}

function CurrentService({
  service,
  state,
  previous,
}: {
  service: DashboardService;
  state: FeaturedState;
  previous?: DashboardService;
}) {
  const statusLabel =
    state === "upcoming"
      ? "Upcoming"
      : state === "in-progress"
        ? "In progress"
        : "Completed";
  const actionLabel =
    state === "upcoming"
      ? "Take attendance"
      : state === "in-progress"
        ? "Continue attendance"
        : "View completed service";
  const contextLabel =
    state === "upcoming"
      ? "Next service"
      : state === "completed"
        ? "Latest service"
        : "Current service";
  const metricService = state === "upcoming" ? previous : service;

  return (
    <>
      <div className="dashboard-service-statusline">
        <span>{contextLabel}</span>
        <span className={`dashboard-service-pill ${state}`}>{statusLabel}</span>
      </div>

      <div className="dashboard-service-main">
        <div className="dashboard-service-copy">
          <h2 id="current-service-title">{service.title}</h2>
          <p className="dashboard-service-when">
            <CalendarDays aria-hidden="true" />
            {formatServiceDate(service.serviceDate)}
            {service.serviceTime && (
              <>
                <span aria-hidden="true">·</span>
                <Clock3 aria-hidden="true" />
                {formatTime(service.serviceTime)}
              </>
            )}
          </p>
        </div>

        <Link
          className={`button ${state === "completed" ? "subtle" : "primary"} dashboard-service-action`}
          href={`/services?service=${service.id}`}
        >
          {state === "completed" && <CheckCircle2 aria-hidden="true" />}
          {actionLabel}
          <ArrowRight aria-hidden="true" />
        </Link>

        {metricService && (
          <div className="dashboard-context-metrics">
            <dl className="dashboard-service-totals" aria-label="Attendance totals">
              <div>
                <dt>
                  {state === "upcoming"
                    ? `Last ${metricService.title}`
                    : "Present"}
                </dt>
                <dd>{metricService.attendanceTotal}</dd>
              </div>
              <div>
                <dt>Visitors</dt>
                <dd>{metricService.visitorCount}</dd>
              </div>
              {metricService.childProgramLabel && (
                <div>
                  <dt>{metricService.childProgramLabel}</dt>
                  <dd>{metricService.sundaySchoolKidsCount ?? 0}</dd>
                </div>
              )}
            </dl>
            {state === "upcoming" && previous && (
              <p className="dashboard-context-caption">
                {previous.title} · {formatServiceDate(previous.serviceDate, false)}
              </p>
            )}
          </div>
        )}
      </div>
    </>
  );
}

function NoService() {
  return (
    <div className="dashboard-no-service">
      <span className="dashboard-service-pill neutral">No service scheduled</span>
      <CalendarDays aria-hidden="true" />
      <h2 id="current-service-title">No upcoming service</h2>
      <p>Create a service when you are ready to begin taking attendance.</p>
      <Link className="button primary dashboard-service-action" href="/services?new=1">
        Create service
        <ArrowRight aria-hidden="true" />
      </Link>
    </div>
  );
}

function RecentServiceRow({ service }: { service: DashboardService }) {
  return (
    <Link
      className="dashboard-recent-row"
      href={`/services?service=${service.id}`}
      aria-label={`Open ${service.title}, ${service.status}`}
    >
      <span className="dashboard-recent-copy">
        <strong>{service.title}</strong>
        <small>
          {shortServiceDate(service.serviceDate)}
          {service.serviceTime ? ` · ${formatTime(service.serviceTime)}` : ""}
        </small>
      </span>
      <span className="dashboard-recent-meta">
        <strong>{service.attendanceTotal}</strong>
        <small className={`dashboard-recent-status ${service.status}`}>
          {service.status === "completed" ? "Completed" : "Draft"}
        </small>
      </span>
    </Link>
  );
}

function SkeletonLine({ className = "" }: { className?: string }) {
  return <span className={`dashboard-skeleton ${className}`} aria-hidden="true" />;
}

function CurrentServiceSkeleton() {
  return (
    <div
      className="dashboard-current-skeleton"
      role="status"
      aria-label="Loading current service"
    >
      <SkeletonLine className="pill" />
      <SkeletonLine className="title" />
      <SkeletonLine />
      <SkeletonLine className="block" />
    </div>
  );
}

function RecentServicesSkeleton() {
  return (
    <div
      className="dashboard-recent-list"
      role="status"
      aria-label="Loading recent services"
    >
      {[0, 1, 2].map((item) => (
        <div className="dashboard-recent-row" key={item}>
          <span className="dashboard-recent-copy">
            <SkeletonLine />
            <SkeletonLine className="short" />
          </span>
          <SkeletonLine className="pill" />
        </div>
      ))}
    </div>
  );
}
