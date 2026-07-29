"use client";

import { useEffect } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { seedDevelopmentMembers } from "@/lib/seed/development-seed";

export function DevelopmentSeed() {
  const { user } = useAuth();
  useEffect(() => {
    if (user) void seedDevelopmentMembers(user);
  }, [user]);
  return null;
}
