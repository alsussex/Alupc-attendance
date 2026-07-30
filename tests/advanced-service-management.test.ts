import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { ChurchService, UserContext } from "@/lib/domain";
import { listAuditEntries } from "@/lib/audit/audit-repository";
import {
  listServices,
  saveService,
  setServiceArchived,
} from "@/lib/repositories/attendance-repository";
import {
  filterServiceDirectory,
  type ServiceDirectoryItem,
} from "@/lib/services/service-directory";
import {
  archivedServices,
  servicesEligibleForBulkArchive,
} from "@/lib/services/service-management";
import { clearLocalDatabase } from "@/lib/storage/database";
import { getPendingChanges } from "@/lib/sync/queue";
import { fromCloudRecord } from "@/lib/sync/serialization";

const organizationId = "20000000-0000-4000-8000-000000000330";
const admin: UserContext = {
  userId: "10000000-0000-4000-8000-000000000330",
  organizationId,
  email: "service-admin@example.test",
  role: "admin",
};

function directoryItem(
  id: string,
  serviceDate: string,
  input: Partial<ChurchService> = {},
): ServiceDirectoryItem {
  return {
    service: {
      id,
      organizationId,
      serviceDate,
      serviceType: "Sunday Morning",
      status: "draft",
      isArchived: false,
      createdAt: "2026-01-01T12:00:00.000Z",
      updatedAt: "2026-01-01T12:00:00.000Z",
      createdBy: admin.userId,
      updatedBy: admin.userId,
      ...input,
    },
    membersPresent: 0,
    visitorsPresent: 0,
    totalPresent: 0,
    lastEditor: "Fictional Administrator",
    pendingSync: false,
    syncState: "synced",
  };
}

beforeEach(async () => {
  await clearLocalDatabase();
});

describe("advanced service management", () => {
  it("persists optional notes locally and in the synchronization payload", async () => {
    const service = await saveService(admin, {
      serviceDate: "2026-07-30",
      serviceType: "Wednesday Bible Study",
      notes: "Set out the fictional study handouts.",
      status: "draft",
    });

    expect((await listServices(organizationId))[0].notes).toBe(
      "Set out the fictional study handouts.",
    );
    const mutation = (await getPendingChanges(organizationId)).find(
      (item) => item.table === "services" && item.recordId === service.id,
    );
    expect(mutation?.payload.notes).toBe(
      "Set out the fictional study handouts.",
    );
  });

  it("downloads service notes from cloud records", () => {
    const local = fromCloudRecord("services", {
      id: "30000000-0000-4000-8000-000000000330",
      organization_id: organizationId,
      service_date: "2026-07-30",
      service_type: "Special Service",
      notes: "Use the side entrance.",
      status: "draft",
      is_archived: false,
      created_at: "2026-07-30T12:00:00.000Z",
      updated_at: "2026-07-30T12:00:00.000Z",
      created_by: admin.userId,
      updated_by: admin.userId,
    });
    expect("notes" in local && local.notes).toBe("Use the side entrance.");
  });

  it("supports token search and structured year, month, type, and status filters", () => {
    const records = [
      directoryItem("july", "2026-07-30", {
        customName: "Community Prayer Night",
        serviceType: "Special Service",
        notes: "Fellowship afterward",
      }),
      directoryItem("june", "2026-06-28", {
        status: "completed",
        serviceType: "Sunday Evening",
      }),
      directoryItem("older", "2025-07-20", {
        status: "completed",
      }),
    ];

    expect(
      filterServiceDirectory(records, "all", "prayer fellowship"),
    ).toHaveLength(1);
    expect(
      filterServiceDirectory(records, "all", "", undefined, {
        year: "2026",
        month: "06",
        serviceType: "Sunday Evening",
      }),
    ).toHaveLength(1);
    expect(filterServiceDirectory(records, "draft", "open")).toHaveLength(1);
    expect(filterServiceDirectory(records, "completed", "")).toHaveLength(2);
  });

  it("bulk archive selection includes only old completed services", () => {
    const services = [
      directoryItem("old-complete", "2025-12-31", {
        status: "completed",
      }).service,
      directoryItem("old-draft", "2025-12-30").service,
      directoryItem("recent-complete", "2026-07-01", {
        status: "completed",
      }).service,
      directoryItem("already-archived", "2025-10-01", {
        status: "completed",
        isArchived: true,
      }).service,
    ];
    expect(
      servicesEligibleForBulkArchive(services, "2026-01-01").map(
        (service) => service.id,
      ),
    ).toEqual(["old-complete"]);
  });

  it("archives and restores the same UUID while preserving audit history", async () => {
    const service = await saveService(admin, {
      serviceDate: "2025-12-21",
      serviceType: "Special Service",
      customName: "Fictional Christmas Service",
      status: "completed",
    });
    await setServiceArchived(admin, service.id, true);
    expect(await listServices(organizationId)).toHaveLength(0);
    expect(archivedServices(await listServices(organizationId, true))[0].id).toBe(
      service.id,
    );

    await setServiceArchived(admin, service.id, false);
    expect((await listServices(organizationId))[0].id).toBe(service.id);
    const history = await listAuditEntries(admin, {
      entityType: "service",
      relatedEntityId: service.id,
      limit: 20,
    });
    expect(history.map((entry) => entry.action)).toEqual(
      expect.arrayContaining(["created", "archived", "restored"]),
    );
  });

  it("keeps archive tools Admin-only and migration security unchanged", () => {
    const settingsSource = readFileSync(
      resolve("components/settings/SettingsCenter.tsx"),
      "utf8",
    );
    const dashboardSource = readFileSync(
      resolve("components/dashboard/Dashboard.tsx"),
      "utf8",
    );
    const migration = readFileSync(
      resolve(
        "supabase/migrations/202607300003_advanced_service_management.sql",
      ),
      "utf8",
    );
    expect(settingsSource).toContain("<ArchivedServicesManager />");
    expect(dashboardSource).toContain('href="/services?new=1"');
    expect(migration).toContain("add column if not exists notes text");
    expect(migration).not.toMatch(/disable row level security/i);
    expect(migration).not.toMatch(/create policy/i);
  });
});
