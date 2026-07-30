import { beforeEach, describe, expect, it } from "vitest";
import {
  PULL_TABLES,
  type Person,
  type PullTable,
  type UserContext,
} from "@/lib/domain";
import {
  getLastAttendanceDates,
  getServiceAttendance,
  listActiveMembers,
  listServices,
  markMemberInactive,
  restoreMember,
  saveMember,
  saveService,
  setMemberAttendance,
} from "@/lib/repositories/attendance-repository";
import { clearLocalDatabase, getDatabase } from "@/lib/storage/database";
import {
  pullOrganizationData,
  type PullSource,
} from "@/lib/sync/pull-service";
import { getPendingChanges } from "@/lib/sync/queue";
import { toCloudRecord } from "@/lib/sync/serialization";
import { synchronizeOrganization } from "@/lib/sync/sync-service";
import {
  uploadPendingChanges,
  type UploadTarget,
} from "@/lib/sync/upload-service";

const organizationId = "20000000-0000-4000-8000-000000000001";
const user: UserContext = {
  userId: "10000000-0000-4000-8000-000000000001",
  organizationId,
  email: "taker@example.test",
  role: "attendance_taker",
};
const administrator: UserContext = {
  ...user,
  email: "admin@example.test",
  role: "admin",
};
const earlier = "2026-07-01T12:00:00.000Z";
const later = "2026-07-02T12:00:00.000Z";

function organizationRow(updatedAt = earlier): Record<string, unknown> {
  return {
    id: organizationId,
    name: "Fictional Community Church",
    slug: "fictional-community",
    created_by: user.userId,
    created_at: earlier,
    updated_at: updatedAt,
  };
}

function profileRow(updatedAt = earlier): Record<string, unknown> {
  return {
    id: user.userId,
    organization_id: organizationId,
    display_name: "Casey Admin",
    role: "admin",
    is_active: true,
    created_at: earlier,
    updated_at: updatedAt,
  };
}

function personRow(
  id = "30000000-0000-4000-8000-000000000001",
  updatedAt = earlier,
  displayName = "Avery Stone",
): Record<string, unknown> {
  const [firstName, lastName] = displayName.split(" ");
  return {
    id,
    organization_id: organizationId,
    first_name: firstName,
    last_name: lastName,
    display_name: displayName,
    person_type: "member",
    is_active: true,
    created_by: user.userId,
    updated_by: user.userId,
    created_at: earlier,
    updated_at: updatedAt,
  };
}

function serviceRow(
  id = "40000000-0000-4000-8000-000000000001",
  updatedAt = earlier,
): Record<string, unknown> {
  return {
    id,
    organization_id: organizationId,
    service_date: "2026-07-05",
    service_type: "Sunday Morning",
    custom_name: null,
    status: "completed",
    created_by: user.userId,
    updated_by: user.userId,
    created_at: earlier,
    updated_at: updatedAt,
  };
}

function attendanceRow(
  id: string,
  personId = "30000000-0000-4000-8000-000000000001",
  serviceId = "40000000-0000-4000-8000-000000000001",
): Record<string, unknown> {
  return {
    id,
    organization_id: organizationId,
    service_id: serviceId,
    person_id: personId,
    present: true,
    created_by: user.userId,
    updated_by: user.userId,
    created_at: earlier,
    updated_at: later,
  };
}

class MemoryPullSource implements PullSource {
  calls: Array<{ table: PullTable; updatedAt?: string }> = [];

  constructor(
    private readonly records: Partial<
      Record<PullTable, Record<string, unknown>[]>
    >,
    private failuresRemaining = 0,
  ) {}

  async fetchPage(
    table: PullTable,
    _organizationId: string,
    updatedAt: string | undefined,
    offset: number,
    limit: number,
  ) {
    this.calls.push({ table, updatedAt });
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error("Temporary network failure");
    }
    const eligible = (this.records[table] ?? []).filter(
      (record) =>
        !updatedAt ||
        String(record.updated_at).localeCompare(updatedAt) >= 0,
    );
    const rows = eligible.slice(offset, offset + limit);
    return { rows, hasMore: offset + limit < eligible.length };
  }
}

class MemoryUploadTarget implements UploadTarget {
  rows = new Map<string, Record<string, unknown>>();
  failuresRemaining = 0;

  async upsert(
    table: "people" | "services" | "service_attendance" | "service_visitors",
    payload: Record<string, unknown>,
  ) {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error("Temporary upload failure");
    }
    this.rows.set(`${table}:${String(payload.id)}`, payload);
  }
}

beforeEach(async () => {
  await clearLocalDatabase();
});

describe("pull synchronization", () => {
  it("hydrates a fresh browser with existing members and services in dependency order", async () => {
    const source = new MemoryPullSource({
      organizations: [organizationRow()],
      profiles: [profileRow()],
      people: [personRow()],
      services: [serviceRow()],
    });

    const result = await pullOrganizationData(organizationId, source);

    expect(result.merged).toBe(4);
    expect((await listActiveMembers(organizationId))[0].displayName).toBe(
      "Avery Stone",
    );
    expect((await listServices(organizationId))[0].status).toBe("completed");
    expect(source.calls.map((call) => call.table)).toEqual(PULL_TABLES);
  });

  it("uses the stored updated_at cursor for incremental pulls", async () => {
    await pullOrganizationData(
      organizationId,
      new MemoryPullSource({ people: [personRow()] }),
    );
    const incremental = new MemoryPullSource({
      people: [personRow(undefined, later, "Avery North")],
    });

    await pullOrganizationData(organizationId, incremental);

    const peopleCall = incremental.calls.find((call) => call.table === "people");
    expect(peopleCall?.updatedAt).toBe(earlier);
    expect((await listActiveMembers(organizationId))[0].displayName).toBe(
      "Avery North",
    );
  });

  it("does not overwrite a pending local write with older cloud data", async () => {
    const local = await saveMember(user, {
      firstName: "Morgan",
      lastName: "Local",
    });
    const cloud = personRow(local.id, earlier, "Morgan Cloud");

    const result = await pullOrganizationData(
      organizationId,
      new MemoryPullSource({ people: [cloud] }),
    );

    expect(result.skippedPending).toBe(1);
    expect((await listActiveMembers(organizationId))[0].displayName).toBe(
      "Morgan Local",
    );
    expect(await getPendingChanges(organizationId)).toHaveLength(1);
  });

  it("trusts the server version when an unqueued device timestamp is newer", async () => {
    const database = await getDatabase();
    const futureLocal: Person = {
      id: "30000000-0000-4000-8000-000000000001",
      organizationId,
      firstName: "Avery",
      lastName: "Device",
      displayName: "Avery Device",
      personType: "member" as const,
      isActive: true,
      createdBy: user.userId,
      updatedBy: user.userId,
      createdAt: earlier,
      updatedAt: "2099-01-01T00:00:00.000Z",
    };
    await database.put("people", futureLocal);

    await pullOrganizationData(
      organizationId,
      new MemoryPullSource({ people: [personRow()] }),
    );

    expect((await listActiveMembers(organizationId))[0].displayName).toBe(
      "Avery Stone",
    );
  });

  it("canonicalizes duplicate attendance rows to one service/person record", async () => {
    await pullOrganizationData(
      organizationId,
      new MemoryPullSource({
        people: [personRow()],
        services: [serviceRow()],
        service_attendance: [
          attendanceRow("legacy-one"),
          attendanceRow("legacy-two"),
        ],
      }),
    );

    const records = await getServiceAttendance(
      "40000000-0000-4000-8000-000000000001",
    );
    expect(records).toHaveLength(1);
    expect(records[0].id).toBe(
      "40000000-0000-4000-8000-000000000001:30000000-0000-4000-8000-000000000001",
    );
  });

  it("rejects a row outside the active organization as defense in depth", async () => {
    const leaked = {
      ...personRow(),
      organization_id: "90000000-0000-4000-8000-000000000009",
    };
    await expect(
      pullOrganizationData(
        organizationId,
        new MemoryPullSource({ people: [leaked] }),
      ),
    ).rejects.toThrow("organization isolation check failed");
  });
});

describe("multi-device upload and retry", () => {
  it("lets a fresh second device see attendance uploaded by the first", async () => {
    const member = await saveMember(user, {
      firstName: "Riley",
      lastName: "Green",
    });
    const service = await saveService(user, {
      serviceDate: "2026-07-12",
      serviceType: "Sunday Evening",
      status: "draft",
    });
    await setMemberAttendance(user, service.id, member.id, true);
    await saveService(user, { ...service, status: "completed" });
    const cloud = new MemoryUploadTarget();
    await uploadPendingChanges(organizationId, cloud);

    const cloudRows: Partial<Record<PullTable, Record<string, unknown>[]>> = {
      people: [],
      services: [],
      service_attendance: [],
    };
    for (const [key, value] of cloud.rows) {
      if (key.startsWith("people:")) cloudRows.people?.push(value);
      if (key.startsWith("services:")) cloudRows.services?.push(value);
      if (key.startsWith("service_attendance:")) {
        cloudRows.service_attendance?.push(value);
      }
    }

    await clearLocalDatabase();
    await pullOrganizationData(
      organizationId,
      new MemoryPullSource(cloudRows),
    );
    expect((await listActiveMembers(organizationId))[0].displayName).toBe(
      "Riley Green",
    );
    expect(await getServiceAttendance(service.id)).toHaveLength(1);
  });

  it("preserves the latest rapid attendance intent on a second device", async () => {
    const member = await saveMember(user, {
      firstName: "Robin",
      lastName: "Field",
    });
    const service = await saveService(user, {
      serviceDate: "2026-07-19",
      serviceType: "Sunday Morning",
      status: "draft",
    });
    await Promise.all([
      setMemberAttendance(user, service.id, member.id, true),
      setMemberAttendance(user, service.id, member.id, false),
    ]);
    const cloud = new MemoryUploadTarget();
    await uploadPendingChanges(organizationId, cloud);

    const cloudRows: Partial<Record<PullTable, Record<string, unknown>[]>> = {
      people: [],
      services: [],
      service_attendance: [],
    };
    for (const [key, value] of cloud.rows) {
      if (key.startsWith("people:")) cloudRows.people?.push(value);
      if (key.startsWith("services:")) cloudRows.services?.push(value);
      if (key.startsWith("service_attendance:")) {
        cloudRows.service_attendance?.push(value);
      }
    }

    await clearLocalDatabase();
    await pullOrganizationData(
      organizationId,
      new MemoryPullSource(cloudRows),
    );

    const attendance = await getServiceAttendance(service.id);
    expect(attendance).toHaveLength(1);
    expect(attendance[0].present).toBe(false);
  });

  it("propagates an offline reactivation to another device without duplication", async () => {
    const member = await saveMember(administrator, {
      firstName: "Taylor",
      lastName: "Meadow",
    });
    const service = await saveService(administrator, {
      serviceDate: "2026-07-26",
      serviceType: "Sunday Morning",
      status: "draft",
    });
    await setMemberAttendance(administrator, service.id, member.id, true);
    await saveService(administrator, { ...service, status: "completed" });
    await markMemberInactive(administrator, member.id);
    const cloud = new MemoryUploadTarget();
    await uploadPendingChanges(organizationId, cloud);

    await restoreMember(administrator, member.id);
    expect(await getPendingChanges(organizationId)).toHaveLength(1);
    await uploadPendingChanges(organizationId, cloud);

    const cloudRows: Partial<Record<PullTable, Record<string, unknown>[]>> = {
      people: [],
      services: [],
      service_attendance: [],
    };
    for (const [key, value] of cloud.rows) {
      if (key.startsWith("people:")) cloudRows.people?.push(value);
      if (key.startsWith("services:")) cloudRows.services?.push(value);
      if (key.startsWith("service_attendance:")) {
        cloudRows.service_attendance?.push(value);
      }
    }

    await clearLocalDatabase();
    await pullOrganizationData(
      organizationId,
      new MemoryPullSource(cloudRows),
    );

    const activeMembers = await listActiveMembers(organizationId);
    expect(activeMembers).toHaveLength(1);
    expect(activeMembers[0]).toMatchObject({ id: member.id, isActive: true });
    expect(await getServiceAttendance(service.id)).toHaveLength(1);
    expect((await getLastAttendanceDates(organizationId)).get(member.id)).toBe(
      "2026-07-26",
    );
  });

  it("uploads offline local changes after reconnection", async () => {
    await saveMember(user, { firstName: "Jamie", lastName: "River" });
    expect(await getPendingChanges(organizationId)).toHaveLength(1);
    const target = new MemoryUploadTarget();

    const result = await uploadPendingChanges(organizationId, target);

    expect(result.uploaded).toBe(1);
    expect(await getPendingChanges(organizationId)).toHaveLength(0);
  });

  it("retains a failed write and succeeds on retry", async () => {
    const member = await saveMember(user, {
      firstName: "Quinn",
      lastName: "Harbor",
    });
    const target = new MemoryUploadTarget();
    target.failuresRemaining = 1;

    const failed = await uploadPendingChanges(organizationId, target);
    expect(failed.errors).toHaveLength(1);
    expect((await getPendingChanges(organizationId))[0].status).toBe("error");

    const retried = await uploadPendingChanges(organizationId, target);
    expect(retried.uploaded).toBe(1);
    expect(target.rows.has(`people:${member.id}`)).toBe(true);
    expect(await getPendingChanges(organizationId)).toHaveLength(0);
  });

  it("retries an interrupted pull without advancing a partial cursor", async () => {
    const source = new MemoryPullSource(
      { organizations: [organizationRow()], profiles: [profileRow()] },
      1,
    );
    const target = new MemoryUploadTarget();

    await expect(
      synchronizeOrganization(user, {
        pullSource: source,
        uploadTarget: target,
        isOnline: true,
      }),
    ).rejects.toThrow("Temporary network failure");

    const result = await synchronizeOrganization(user, {
      pullSource: source,
      uploadTarget: target,
      isOnline: true,
    });
    expect(result.pull.merged).toBe(2);
    expect(await getDatabase().then((db) => db.get("organizations", organizationId))).toBeTruthy();
  });
});

describe("cloud serialization", () => {
  it("keeps uploaded identities stable", () => {
    expect(
      toCloudRecord({
        id: "stable-id",
        organizationId,
        updatedAt: later,
      }),
    ).toEqual({
      id: "stable-id",
      organization_id: organizationId,
      updated_at: later,
    });
  });
});
