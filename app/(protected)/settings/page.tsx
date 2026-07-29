import { AdminOnly } from "@/components/auth/AdminOnly";

export default function SettingsPage() {
  return (
    <AdminOnly>
      <div className="page-stack">
        <div className="page-heading">
          <p className="eyebrow">Administrator</p>
          <h1>Organization settings</h1>
          <p>Administrative settings for Abundant Life UPC.</p>
        </div>
        <section className="empty-panel">
          <h2>Organization controls</h2>
          <p>User access is managed from User Management. Additional organization settings remain intentionally limited.</p>
        </section>
      </div>
    </AdminOnly>
  );
}
