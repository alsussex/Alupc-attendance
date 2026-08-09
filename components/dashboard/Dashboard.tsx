"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  Clock3,
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

function formatServiceDate(value: string, includeYear = true) {
  return new Date(`${value}T12:00:00`).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: includeYear ? "numeric" : undefined,
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
    />
  );
}

export function DashboardView(props: {
  snapshot: DashboardSnapshot;
  loading: boolean;
  error?: string;
  isAdministrator: boolean;
  currentDate?: Date;
}) {
  const { snapshot, loading, error = "", currentDate } = props;
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
  const nextService = useMemo(
    () =>
      state === "completed"
        ? snapshot.services
            .filter(
              (service) =>
                service.status === "draft" &&
                serviceMoment(service) > serviceMoment(featured!),
            )
            .sort(oldestFirst)[0]
        : undefined,
    [featured, snapshot.services, state],
  );
  const recentServices = useMemo(
    () =>
      [...snapshot.services]
        .filter((service) => service.id !== featured?.id)
        .sort(newestFirst)
        .slice(0, 4),
    [featured?.id, snapshot.services],
  );

  return (
    <main className="dashboard dashboard-home" aria-labelledby="dashboard-title">
      <header className="dashboard-home-heading">
        <div>
          <p className="dashboard-home-greeting">{greetingFor(now)}</p>
          <h1 id="dashboard-title">{snapshot.churchName} Attendance</h1>
          <p>
            {now.toLocaleDateString(undefined, {
              weekday: "long",
              month: "long",
              day: "numeric",
              year: "numeric",
            })}
          </p>
        </div>
        <Link className="button primary dashboard-create-service" href="/services?new=1">
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
              nextService={nextService}
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
    </main>
  );
}

function CurrentService({
  service,
  state,
  previous,
  nextService,
}: {
  service: DashboardService;
  state: FeaturedState;
  previous?: DashboardService;
  nextService?: DashboardService;
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

  return (
    <>
      <div className="dashboard-service-statusline">
        <span>Current service</span>
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
                {state === "upcoming" ? "Starts at " : ""}
                {formatTime(service.serviceTime)}
              </>
            )}
          </p>
        </div>

        {(state !== "upcoming" || service.attendanceTotal > 0) && (
          <dl className="dashboard-service-totals" aria-label="Attendance totals">
            <div>
              <dt>Total present</dt>
              <dd>{service.attendanceTotal}</dd>
            </div>
            <div>
              <dt>Visitors</dt>
              <dd>{service.visitorCount}</dd>
            </div>
            {service.childProgramLabel && (
              <div>
                <dt>{service.childProgramLabel}</dt>
                <dd>{service.sundaySchoolKidsCount ?? 0}</dd>
              </div>
            )}
          </dl>
        )}

        <Link
          className={`button ${state === "completed" ? "" : "primary"} dashboard-service-action`}
          href={`/services?service=${service.id}`}
        >
          {state === "completed" && <CheckCircle2 aria-hidden="true" />}
          {actionLabel}
          <ArrowRight aria-hidden="true" />
        </Link>

        {state === "completed" && nextService && (
          <p className="dashboard-next-service">
            Next: <Link href={`/services?service=${nextService.id}`}>{nextService.title}</Link>
            <span>
              {shortServiceDate(nextService.serviceDate)}
              {nextService.serviceTime
                ? ` · ${formatTime(nextService.serviceTime)}`
                : ""}
            </span>
          </p>
        )}
      </div>

      {previous && (
        <p className="dashboard-previous-service">
          Last {previous.title}: {previous.attendanceTotal} attended ·{" "}
          {previous.visitorCount} visitors
          {previous.childProgramLabel
            ? ` · ${previous.sundaySchoolKidsCount ?? 0} ${previous.childProgramLabel}`
            : ""}
        </p>
      )}
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
