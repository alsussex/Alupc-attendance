"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { useConfirmation } from "@/components/feedback/ConfirmationProvider";
import { EmptyState } from "@/components/feedback/EmptyState";
import { useToast } from "@/components/feedback/ToastProvider";
import type { ChurchService } from "@/lib/domain";
import {
  listServices,
  setServiceArchived,
} from "@/lib/repositories/attendance-repository";
import {
  archivedServices,
  serviceDisplayName,
  servicesEligibleForBulkArchive,
} from "@/lib/services/service-management";
import { formatDate, formatDateTime, formatTime } from "@/lib/format/date-time";
import { subscribeToDataChanges } from "@/lib/storage/data-events";

function defaultArchiveDate() {
  const date = new Date();
  return `${date.getFullYear()}-01-01`;
}

export function ArchivedServicesManager() {
  const { user } = useAuth();
  const confirmAction = useConfirmation();
  const { showToast } = useToast();
  const [services, setServices] = useState<ChurchService[]>([]);
  const [search, setSearch] = useState("");
  const [beforeDate, setBeforeDate] = useState(defaultArchiveDate);
  const [working, setWorking] = useState(false);

  const refresh = useCallback(async () => {
    if (!user) return;
    setServices(await listServices(user.organizationId, true));
  }, [user]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    const unsubscribe = subscribeToDataChanges(() => void refresh());
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [refresh]);

  const archived = useMemo(
    () => archivedServices(services, search),
    [search, services],
  );
  const eligible = useMemo(
    () => servicesEligibleForBulkArchive(services, beforeDate),
    [beforeDate, services],
  );

  async function restore(service: ChurchService) {
    if (!user || working) return;
    if (
      !(await confirmAction({
        title: `Restore ${serviceDisplayName(service)}?`,
        message:
          "The service will return to the organization service list with its attendance and history intact.",
        confirmLabel: "Restore service",
      }))
    ) {
      return;
    }
    setWorking(true);
    try {
      await setServiceArchived(user, service.id, false);
      await refresh();
      showToast("Service restored.", { key: `service-restored:${service.id}` });
    } finally {
      setWorking(false);
    }
  }

  async function bulkArchive() {
    if (!user || working || eligible.length === 0) return;
    if (
      !(await confirmAction({
        title: `Archive ${eligible.length} old ${
          eligible.length === 1 ? "service" : "services"
        }?`,
        message:
          "Only completed services before the selected date will be archived. Attendance and audit history will remain available.",
        confirmLabel: `Archive ${eligible.length}`,
        tone: "danger",
      }))
    ) {
      return;
    }
    setWorking(true);
    try {
      for (const service of eligible) {
        await setServiceArchived(user, service.id, true);
      }
      await refresh();
      showToast(
        `${eligible.length} completed ${
          eligible.length === 1 ? "service" : "services"
        } archived.`,
        { key: `services-bulk-archived:${beforeDate}` },
      );
    } finally {
      setWorking(false);
    }
  }

  return (
    <section className="panel settings-card archived-services-settings">
      <div className="settings-card-heading">
        <p className="eyebrow">Service archive</p>
        <h2>Archived services</h2>
        <p>
          Keep older completed services out of everyday lists without removing
          attendance or audit history.
        </p>
      </div>
      <div className="settings-card-body">
        <section className="bulk-archive-controls" aria-labelledby="bulk-archive-title">
          <div>
            <h3 id="bulk-archive-title">Bulk archive old services</h3>
            <p>
              Archive completed services before a date. Draft and open services
              are never included.
            </p>
          </div>
          <label>
            Completed before
            <input
              type="date"
              value={beforeDate}
              onChange={(event) => setBeforeDate(event.target.value)}
            />
          </label>
          <button
            className="button secondary"
            type="button"
            disabled={working || eligible.length === 0}
            onClick={() => void bulkArchive()}
          >
            {working
              ? "Working…"
              : `Archive ${eligible.length} ${
                  eligible.length === 1 ? "service" : "services"
                }`}
          </button>
        </section>

        <label className="search-field">
          <span className="sr-only">Search archived services</span>
          <span aria-hidden="true">⌕</span>
          <input
            type="search"
            value={search}
            placeholder="Search archived services"
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>

        <div className="archived-service-list" aria-live="polite">
          {archived.map((service) => (
            <article key={service.id}>
              <div>
                <strong>{serviceDisplayName(service)}</strong>
                <span>
                  {formatDate(service.serviceDate)}
                  {service.serviceTime ? ` · ${formatTime(service.serviceTime)}` : ""}
                </span>
                <small>Archived {formatDateTime(service.updatedAt)}</small>
              </div>
              <button
                className="button secondary"
                type="button"
                disabled={working}
                onClick={() => void restore(service)}
                aria-label={`Restore ${serviceDisplayName(service)}`}
              >
                Restore
              </button>
            </article>
          ))}
          {archived.length === 0 && (
            <EmptyState
              compact
              icon="▣"
              title={search ? "No archived services match" : "No archived services"}
              message={
                search
                  ? "Try a different service name, type, date, or note."
                  : "Archived services will appear here for administrators."
              }
            />
          )}
        </div>
      </div>
    </section>
  );
}
