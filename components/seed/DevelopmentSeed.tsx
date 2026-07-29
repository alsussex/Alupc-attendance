"use client";

import { useEffect } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { seedDevelopmentMembers } from "@/lib/seed/development-seed";
import { useSynchronization } from "@/components/sync/SyncProvider";

export function DevelopmentSeed() {
  const { user } = useAuth();
  const { phase } = useSynchronization();
  useEffect(() => {
    if (user && phase === "complete") void seedDevelopmentMembers(user);
  }, [phase, user]);
  return null;
}
