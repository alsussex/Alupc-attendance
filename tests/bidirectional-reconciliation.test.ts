import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PullTable,
  UserContext,
} from "@/lib/domain";
import {
  getServiceAttendance,
  listMembers,
  listServiceVisitors,
  saveMember,
} from "@/lib/repositories/attendance-repository";
import {
  pullOrganizationData,
  type PullSource,
} from "@/lib/sync/pull-service";
import {
  activeRemoteSubscriptionCount,
  subscribeToRemoteOrganizationChanges,
} from "@/lib/sync/remote-change-listener";
import {
  isAuthenticationSynchronizationError,
  synchronizeWithSessionRecovery,
} from "@/lib/sync/sync-service";
import type {
  UploadTarget,
} from "@/lib/sync/upload-service";
import {
  SynchronizationConflictError,
  uploadPendingChanges,
} from "@/lib/sync/upload-service";
import {
  clearLocalDatabase,
  getDatabase,
} from "@/lib/storage/database";
import { getPendingChanges } from "@/lib/sync/queue";
import type {
  RealtimeChannel,
  SupabaseClient,
} from "@supabase/supabase-js";

const organizationId = "20000000-0000-4000-8000-000000000090";
const user: UserContext = {
  userId: "10000000-0000-4000-8000-000000000090",
  organizationId,
  email: "admin@example.test",
  role: "admin",
};
const now = "2026-07-29T12:00:00.000Z";

class EmptyPullSource implements PullSource {
  calls: Array<{ table: PullTable; updatedAt?: string }> = [];

  async fetchPage(
    table: PullTable,
    _organizationId: string,
    updatedAt: string | undefined,
  ) {
    this.calls.push({ table, updatedAt });
    return { rows: [], hasMore: false };
  }
}

class RowsPullSource implements PullSource {
  constructor(
    private readonly rows: Partial<
      Record<PullTable, Record<string, unknown>[]>
    >,
  ) {}

  async fetchPage(table: PullTable) {
    return { rows: this.rows[table] ?? [], hasMore: false };
  }
}

function personRow(input: {
  id: string;
  name: string;
  active?: boolean;
  version?: number;
}) {
  const [firstName, lastName] = input.name.split(" ");
  return {
    id: input.id,
    organization_id: organizationId,
    first_name: firstName,
    last_name: lastName,
    display_name: input.name,
    person_type: "member",
    is_active: input.active ?? true,
    inactive_at: input.active === false ? now : null,
    version: input.version ?? 1,
    created_by: user.userId,
    updated_by: user.userId,
    created_at: now,
    updated_at: now,
  };
}

beforeEach(async () => {
  await clearLocalDatabase();
});

describe("session-aware synchronization recovery", () => {
  it("refreshes access once and retries an authentication failure", async () => {
    await saveMember(user, { firstName: "Avery", lastName: "Stone" });
    const pull = new EmptyPullSource();
    let attempts = 0;
    const target: UploadTarget = {
      async upsert() {
        attempts += 1;
        if (attempts === 1) throw new Error("JWT expired");
      },
    };
    const recoverAccess = vi.fn(async () => user);

    const result = await synchronizeWithSessionRecovery(user, {
      pullSource: pull,
      uploadTarget: target,
      isOnline: true,
      recoverAccess,
    });

    expect(recoverAccess).toHaveBeenCalledTimes(1);
    expect(attempts).toBe(3);
    expect(result.upload.errors).toEqual([]);
    expect(await getPendingChanges(organizationId)).toHaveLength(0);
  });

  it("retains offline work and avoids an infinite retry when refresh fails", async () => {
    await saveMember(user, { firstName: "Morgan", lastName: "Lane" });
    const target: UploadTarget = {
      async upsert() {
        throw new Error("401 invalid refresh token");
      },
    };
    const recoverAccess = vi.fn(async () => null);

    const result = await synchronizeWithSessionRecovery(user, {
      pullSource: new EmptyPullSource(),
      uploadTarget: target,
      isOnline: true,
      recoverAccess,
    });

    expect(recoverAccess).toHaveBeenCalledTimes(1);
    expect(result.upload.errors).toHaveLength(2);
    expect(await getPendingChanges(organizationId)).toHaveLength(1);
  });

  it("does not misclassify RLS authorization failures as expired authentication", () => {
    expect(
      isAuthenticationSynchronizationError(
        "new row violates row-level security policy (42501)",
      ),
    ).toBe(false);
    expect(
      isAuthenticationSynchronizationError("403 permission denied"),
    ).toBe(false);
    expect(isAuthenticationSynchronizationError("JWT expired")).toBe(true);
    expect(isAuthenticationSynchronizationError("401 invalid token")).toBe(
      true,
    );
  });

  it("contains explicit TOKEN_REFRESHED, SIGNED_IN, and SIGNED_OUT recovery", () => {
    const source = readFileSync(
      resolve("components/auth/AuthProvider.tsx"),
      "utf8",
    );
    expect(source).toContain('event === "TOKEN_REFRESHED"');
    expect(source).toContain('event === "SIGNED_IN"');
    expect(source).toContain('event === "SIGNED_OUT"');
    expect(source).toContain(".auth.refreshSession()");
    expect(source).toContain('.from("organizations")');
  });
});

describe("incremental remote reconciliation", () => {
  it("downloads a remote member edit and inactive lifecycle without changing its UUID", async () => {
    const memberId = "30000000-0000-4000-8000-000000000090";
    const serviceId = "40000000-0000-4000-8000-000000000090";
    const attendanceId = "50000000-0000-4000-8000-000000000090";
    const source = new RowsPullSource({
      people: [
        personRow({
          id: memberId,
          name: "Avery River",
          active: false,
          version: 4,
        }),
      ],
      service_attendance: [
        {
          id: attendanceId,
          organization_id: organizationId,
          service_id: serviceId,
          person_id: memberId,
          present: true,
          version: 2,
          created_by: user.userId,
          updated_by: user.userId,
          created_at: now,
          updated_at: now,
        },
      ],
    });

    await pullOrganizationData(user, source);
    const member = (await listMembers(organizationId))[0];
    const attendance = await getServiceAttendance(serviceId);
    expect(member).toMatchObject({
      id: memberId,
      displayName: "Avery River",
      isActive: false,
      version: 4,
    });
    expect(attendance[0]).toMatchObject({
      personId: memberId,
      present: true,
    });
  });

  it("keeps visitor tombstones and remote profile access changes", async () => {
    const visitorId = "60000000-0000-4000-8000-000000000090";
    const serviceId = "40000000-0000-4000-8000-000000000090";
    await pullOrganizationData(
      user,
      new RowsPullSource({
        profiles: [
          {
            id: user.userId,
            organization_id: organizationId,
            display_name: "Casey Admin",
            role: "attendance_taker",
            is_active: false,
            created_at: now,
            updated_at: now,
          },
        ],
        service_visitors: [
          {
            id: visitorId,
            organization_id: organizationId,
            service_id: serviceId,
            first_name: "Jordan",
            last_name: "West",
            display_name: "Jordan West",
            saved_as_member: false,
            deleted_at: now,
            version: 3,
            created_by: user.userId,
            updated_by: user.userId,
            created_at: now,
            updated_at: now,
          },
        ],
      }),
    );
    expect(await listServiceVisitors(serviceId)).toHaveLength(0);
    await expect((await getDatabase()).get("profiles", user.userId)).resolves.toMatchObject({
      role: "attendance_taker",
      isActive: false,
    });

    await pullOrganizationData(
      user,
      new RowsPullSource({
        profiles: [
          {
            id: user.userId,
            organization_id: organizationId,
            display_name: "Casey Admin",
            role: "admin",
            is_active: true,
            created_at: now,
            updated_at: "2026-07-29T12:01:00.000Z",
          },
        ],
      }),
    );
    await expect((await getDatabase()).get("profiles", user.userId)).resolves.toMatchObject({
      role: "admin",
      isActive: true,
    });
  });

  it("stores pull cursors per user and organization", async () => {
    const first = new EmptyPullSource();
    await pullOrganizationData(user, first);
    const second = new EmptyPullSource();
    await pullOrganizationData(
      { ...user, userId: "10000000-0000-4000-8000-000000000091" },
      second,
    );
    expect(second.calls.every((call) => call.updatedAt === undefined)).toBe(
      true,
    );
  });
});

describe("remote subscription lifecycle", () => {
  function fakeRealtimeClient() {
    const filters: Array<Record<string, string>> = [];
    const channel = {
      on(
        _type: string,
        filter: Record<string, string>,
        callback: () => void,
      ) {
        void callback;
        filters.push(filter);
        return this;
      },
      subscribe() {
        return this;
      },
    };
    const removeChannel = vi.fn(async () => "ok");
    return {
      client: {
        channel: vi.fn(() => channel),
        removeChannel,
      } as unknown as SupabaseClient,
      channel: channel as unknown as RealtimeChannel,
      filters,
      removeChannel,
    };
  }

  it("deduplicates subscriptions and scopes every listener to one organization", () => {
    const fake = fakeRealtimeClient();
    const stopA = subscribeToRemoteOrganizationChanges(user, vi.fn(), fake.client);
    const stopB = subscribeToRemoteOrganizationChanges(user, vi.fn(), fake.client);
    expect(activeRemoteSubscriptionCount()).toBe(1);
    expect(fake.filters).toHaveLength(8);
    expect(
      fake.filters.every((filter) =>
        filter.filter?.includes(organizationId),
      ),
    ).toBe(true);
    stopA();
    expect(fake.removeChannel).not.toHaveBeenCalled();
    stopB();
    expect(fake.removeChannel).toHaveBeenCalledWith(fake.channel);
    expect(activeRemoteSubscriptionCount()).toBe(0);
  });

  it("removes the previous organization subscription when users switch", () => {
    const first = fakeRealtimeClient();
    const stopFirst = subscribeToRemoteOrganizationChanges(
      user,
      vi.fn(),
      first.client,
    );
    stopFirst();
    const second = fakeRealtimeClient();
    const stopSecond = subscribeToRemoteOrganizationChanges(
      { ...user, organizationId: "20000000-0000-4000-8000-000000000099" },
      vi.fn(),
      second.client,
    );
    expect(activeRemoteSubscriptionCount()).toBe(1);
    expect(first.removeChannel).toHaveBeenCalledTimes(1);
    stopSecond();
  });
});

describe("database conflict safeguards", () => {
  const migration = readFileSync(
    resolve(
      "supabase/migrations/202607290009_bidirectional_reconciliation.sql",
    ),
    "utf8",
  );

  it("adds server versions and idempotent mutation receipts without weakening RLS", () => {
    expect(migration).toContain("version bigint not null default 1");
    expect(migration).toContain("last_mutation_id uuid");
    expect(migration).toContain("new.version := old.version + 1");
    expect(migration).not.toMatch(/disable row level security/i);
    expect(migration).not.toMatch(/\bcreate policy\b/i);
  });

  it("uploads against the local base version and removes a confirmed mutation", async () => {
    const database = await getDatabase();
    const member = await saveMember(user, {
      firstName: "Robin",
      lastName: "Field",
    });
    await database.put("people", { ...member, version: 7 });
    await database.clear("syncQueue");
    await saveMember(user, {
      id: member.id,
      firstName: "Robin",
      lastName: "Meadow",
    });
    const contexts: Array<{ expectedVersion?: number }> = [];
    const target: UploadTarget = {
      async upsert(table, _payload, _conflict, context) {
        if (table === "people") {
          contexts.push({ expectedVersion: context?.expectedVersion });
        }
        return { version: 8, updatedAt: now };
      },
    };
    await uploadPendingChanges(organizationId, target);
    expect(contexts).toEqual([{ expectedVersion: 7 }]);
    expect(await getPendingChanges(organizationId)).toHaveLength(0);
  });

  it("retains a same-record conflict instead of overwriting the remote row", async () => {
    const member = await saveMember(user, {
      firstName: "Casey",
      lastName: "Harbor",
    });
    const database = await getDatabase();
    await database.put("people", { ...member, version: 2 });
    await database.clear("syncQueue");
    await saveMember(user, {
      id: member.id,
      firstName: "Casey",
      lastName: "River",
    });
    const target: UploadTarget = {
      async upsert() {
        throw new SynchronizationConflictError(
          "The server record is newer.",
        );
      },
    };
    const result = await uploadPendingChanges(organizationId, target);
    expect(result.errors[0]).toContain("SYNC_CONFLICT");
    const queued = await getPendingChanges(organizationId);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      recordId: member.id,
      status: "error",
      baseVersion: 2,
    });
  });
});
