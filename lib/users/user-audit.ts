import type { UserRole } from "@/lib/domain";

interface UserAuditRecordInput {
  id: string;
  organizationId: string;
  actorId: string;
  actorDisplayName: string | null;
  actorRole: UserRole;
  entityId: string;
  action: string;
  details: Record<string, unknown>;
  occurredAt?: string;
}

export function buildUserAuditRecord(input: UserAuditRecordInput) {
  return {
    id: input.id,
    organization_id: input.organizationId,
    entity_type: "user" as const,
    entity_id: input.entityId,
    action: input.action,
    user_id: input.actorId,
    user_display_name: input.actorDisplayName || "Administrator",
    role: input.actorRole,
    occurred_at: input.occurredAt ?? new Date().toISOString(),
    details: input.details,
    version: 1,
    last_mutation_id: input.id,
  };
}
