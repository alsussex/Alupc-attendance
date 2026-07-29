import { redirect } from "next/navigation";

export default function UsersPage() {
  redirect("/settings?section=users");
}
