import { AdminOnly } from "@/components/auth/AdminOnly";
import { SettingsCenter } from "@/components/settings/SettingsCenter";

export default function SettingsPage() {
  return (
    <AdminOnly>
      <SettingsCenter />
    </AdminOnly>
  );
}
