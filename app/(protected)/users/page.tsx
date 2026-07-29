import { AdminOnly } from "@/components/auth/AdminOnly";
import { UserManagement } from "@/components/users/UserManagement";

export default function UsersPage() {
  return (
    <AdminOnly>
      <UserManagement />
    </AdminOnly>
  );
}
