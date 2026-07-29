"use client";

import type { UserContext } from "@/lib/domain";
import { listActiveMembers, saveMember } from "@/lib/repositories/attendance-repository";

const FICTIONAL_MEMBERS = [
  { firstName: "Jack", lastName: "Black" },
  { firstName: "Chris", lastName: "Cummings" },
  { firstName: "Taylor", lastName: "Swift" },
];

export async function seedDevelopmentMembers(user: UserContext) {
  if (process.env.NEXT_PUBLIC_ENABLE_DEMO_SEED !== "true") return;
  if ((await listActiveMembers(user.organizationId)).length > 0) return;
  await Promise.all(FICTIONAL_MEMBERS.map((person) => saveMember(user, person)));
}
