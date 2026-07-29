import { ProtectedRoute } from "@/components/auth/ProtectedRoute";
import { AppShell } from "@/components/shell/AppShell";
import { DevelopmentSeed } from "@/components/seed/DevelopmentSeed";
import { SyncProvider } from "@/components/sync/SyncProvider";

export default function ProtectedLayout({ children }: { children: React.ReactNode }) {
  return (
    <ProtectedRoute>
      <SyncProvider>
        <DevelopmentSeed />
        <AppShell>{children}</AppShell>
      </SyncProvider>
    </ProtectedRoute>
  );
}
