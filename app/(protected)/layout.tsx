import { ProtectedRoute } from "@/components/auth/ProtectedRoute";
import { AppShell } from "@/components/shell/AppShell";
import { DevelopmentSeed } from "@/components/seed/DevelopmentSeed";

export default function ProtectedLayout({ children }: { children: React.ReactNode }) {
  return (
    <ProtectedRoute>
      <DevelopmentSeed />
      <AppShell>{children}</AppShell>
    </ProtectedRoute>
  );
}
