"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { useSynchronization } from "@/components/sync/SyncProvider";
import { EmptyState } from "@/components/feedback/EmptyState";
import { LoadingSkeleton } from "@/components/feedback/LoadingSkeleton";
import {
  buildAuditExport,
  listAuditEntries,
  type AuditFilters,
} from "@/lib/audit/audit-repository";
import { isAdmin } from "@/lib/auth/permissions";
import type {
  AuditEntityType,
  AuditLogEntry,
  ChurchService,
} from "@/lib/domain";
import { downloadText } from "@/lib/settings/exports";
import { subscribeToDataChanges } from "@/lib/storage/data-events";
import { getDatabase } from "@/lib/storage/database";
import { formatDateTime } from "@/lib/format/date-time";
import { subscribeToRemoteOrganizationChanges } from "@/lib/sync/remote-change-listener";

const entityLabels: Record<AuditEntityType, string> = {
  service: "Service",
  attendance: "Attendance",
  visitor: "Visitor",
  member: "Member",
  user: "User",
  settings: "Settings",
};

function titleCase(value: string) {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function detailSummary(entry: AuditLogEntry) {
  const details = entry.details ?? {};
  const name =
    typeof details.name === "string"
      ? details.name
      : typeof details.personName === "string"
        ? details.personName
        : typeof details.targetName === "string"
          ? details.targetName
          : "";
  if (
    typeof details.fromRole === "string" &&
    typeof details.toRole === "string" &&
    details.fromRole !== details.toRole
  ) {
    return `${name ? `${name} · ` : ""}${titleCase(details.fromRole)} → ${titleCase(details.toRole)}`;
  }
  const from =
    typeof details.from === "string" ||
    typeof details.from === "number" ||
    typeof details.from === "boolean"
      ? String(details.from)
      : "";
  const to =
    typeof details.to === "string" ||
    typeof details.to === "number" ||
    typeof details.to === "boolean"
      ? String(details.to)
      : "";
  if (from || to) return [name, `${from || "None"} → ${to || "None"}`].filter(Boolean).join(" · ");
  if (
    details.changes &&
    typeof details.changes === "object" &&
    !Array.isArray(details.changes)
  ) {
    const fields = Object.keys(details.changes);
    return `${name ? `${name} · ` : ""}${fields.length} setting${fields.length === 1 ? "" : "s"} changed`;
  }
  return name;
}

function formatTimestamp(value: string) {
  return formatDateTime(value);
}

export function AuditHistory({
  entityType,
  entityId,
  relatedEntityId,
  relatedEntityIds,
  compact = false,
}: {
  entityType?: AuditEntityType;
  entityId?: string;
  relatedEntityId?: string;
  relatedEntityIds?: string[];
  compact?: boolean;
}) {
  const { user } = useAuth();
  const { refreshTables } = useSynchronization();
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedEntity, setSelectedEntity] = useState<
    AuditEntityType | "all"
  >(entityType ?? "all");
  const [action, setAction] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [services, setServices] = useState<ChurchService[]>([]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [error, setError] = useState("");

  const filters = useMemo<AuditFilters>(
    () => ({
      entityType:
        entityType ?? (selectedEntity === "all" ? undefined : selectedEntity),
      entityId,
      relatedEntityId: relatedEntityId || serviceId || undefined,
      relatedEntityIds,
      query: query || undefined,
      action: action || undefined,
      from: from ? new Date(`${from}T00:00:00`).toISOString() : undefined,
      to: to ? new Date(`${to}T23:59:59.999`).toISOString() : undefined,
      limit: compact ? 20 : 50,
    }),
    [action, compact, entityId, entityType, from, query, relatedEntityId, relatedEntityIds, selectedEntity, serviceId, to],
  );

  const load = useCallback(async () => {
    if (!user || !isAdmin(user)) return;
    setLoading(true);
    try {
      const page = await listAuditEntries(user, filters);
      setEntries(page);
      setHasMore(page.length === (filters.limit ?? 50));
      setError("");
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "History could not be loaded.",
      );
    } finally {
      setLoading(false);
    }
  }, [filters, user]);

  useEffect(() => {
    if (!user || !isAdmin(user) || !navigator.onLine) return;
    void refreshTables(["audit_log"]);
    return subscribeToRemoteOrganizationChanges(
      user,
      () => void refreshTables(["audit_log"]),
      undefined,
      ["audit_log"],
    );
  }, [refreshTables, user]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    const unsubscribe = subscribeToDataChanges(() => void load());
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [load]);

  useEffect(() => {
    if (compact || !user || !isAdmin(user)) return;
    void getDatabase()
      .then((database) =>
        database.getAllFromIndex(
          "services",
          "organizationId",
          user.organizationId,
        ),
      )
      .then((records) =>
        setServices(
          records
            .filter((service) => !service.deletedAt)
            .sort((a, b) => b.serviceDate.localeCompare(a.serviceDate)),
        ),
      );
  }, [compact, user]);

  if (!user || !isAdmin(user)) {
    return (
      <div className="notice error" role="alert">
        Audit history is available to administrators only.
      </div>
    );
  }

  async function loadOlder() {
    const last = entries.at(-1);
    if (!last || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await listAuditEntries(user!, {
        ...filters,
        before: `${last.occurredAt}|${last.id}`,
      });
      setEntries((current) => [...current, ...page]);
      setHasMore(page.length === (filters.limit ?? 50));
    } finally {
      setLoadingOlder(false);
    }
  }

  async function exportHistory(format: "csv" | "json") {
    const content = await buildAuditExport(user!, format);
    const date = new Date().toISOString().slice(0, 10);
    downloadText(
      content,
      `audit-history-${date}.${format}`,
      format === "csv" ? "text/csv" : "application/json",
    );
  }

  return (
    <section className={`audit-history ${compact ? "compact" : ""}`}>
      {!compact && (
        <>
          <div className="settings-card-heading with-action">
            <div>
              <p className="eyebrow">Accountability</p>
              <h2>Audit history</h2>
              <p>
                A permanent, organization-wide record of meaningful changes.
              </p>
            </div>
            <div className="button-row">
              <button
                className="button subtle"
                type="button"
                onClick={() => void exportHistory("csv")}
              >
                Export CSV
              </button>
              <button
                className="button subtle"
                type="button"
                onClick={() => void exportHistory("json")}
              >
                Export JSON
              </button>
            </div>
          </div>
          <div className="audit-filters" aria-label="Audit history filters">
            <label>
              Search
              <input
                type="search"
                placeholder="User, action, service, member…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            {!entityType && (
              <label>
                Entity
                <select
                  value={selectedEntity}
                  onChange={(event) =>
                    setSelectedEntity(
                      event.target.value as AuditEntityType | "all",
                    )
                  }
                >
                  <option value="all">All entities</option>
                  {Object.entries(entityLabels).map(([value, label]) => (
                    <option value={value} key={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              Action
              <input
                value={action}
                placeholder="For example: completed"
                onChange={(event) => setAction(event.target.value)}
              />
            </label>
            <label>
              Service
              <select
                value={serviceId}
                onChange={(event) => setServiceId(event.target.value)}
              >
                <option value="">All services</option>
                {services.map((service) => (
                  <option value={service.id} key={service.id}>
                    {service.customName || service.serviceType} ·{" "}
                    {service.serviceDate}
                  </option>
                ))}
              </select>
            </label>
            <label>
              From
              <input
                type="date"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
              />
            </label>
            <label>
              To
              <input
                type="date"
                value={to}
                onChange={(event) => setTo(event.target.value)}
              />
            </label>
          </div>
        </>
      )}

      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      {loading ? (
        <LoadingSkeleton label="Loading history" rows={3} />
      ) : entries.length === 0 ? (
        <EmptyState
          compact
          icon="↺"
          title="No history yet"
          message="Meaningful changes will appear here as they are made."
        />
      ) : (
        <ol className="audit-timeline" aria-label="Audit history, newest first">
          {entries.map((entry) => {
            const summary = detailSummary(entry);
            return (
              <li key={entry.id}>
                <span className="audit-marker" aria-hidden="true" />
                <div className="audit-entry">
                  <div className="audit-entry-heading">
                    <strong>{titleCase(entry.action)}</strong>
                    <span className="audit-entity">
                      {entityLabels[entry.entityType]}
                    </span>
                  </div>
                  {summary && <p>{summary}</p>}
                  <div className="audit-entry-meta">
                    <span>{entry.userDisplayName}</span>
                    <span>{titleCase(entry.role)}</span>
                    <time dateTime={entry.occurredAt}>
                      {formatTimestamp(entry.occurredAt)}
                    </time>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {hasMore && !loading && (
        <button
          className="button subtle audit-load-more"
          type="button"
          disabled={loadingOlder}
          onClick={() => void loadOlder()}
        >
          {loadingOlder ? "Loading…" : "Load older history"}
        </button>
      )}
    </section>
  );
}
