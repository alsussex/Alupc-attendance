# Church Attendance

Offline-capable church attendance Progressive Web App for Abundant Life UPC. Authorized users can maintain the member directory, create services, record attendance by name, and add one-time visitors. IndexedDB is the immediate data source; Supabase provides authentication, organization-scoped cloud storage, and multi-device synchronization.

## Included

- Supabase email/password login with persistent per-device sessions and no public registration
- Admin and Attendance Taker roles enforced in the interface, server routes, database triggers, and RLS
- Admin-only invitations, role changes, access suspension/restoration, resend, and pending-invitation cancellation
- Responsive Dashboard, People, Services, and Admin-only Settings center
- Organization, service, attendance, visitor, device, security, and export settings
- Active/inactive/all member views, member profiles, search, duplicate-name warning, and Admin lifecycle controls
- Smart duplicate suggestions, Admin merge previews, recently added/restored views, and attendance-aware member sorting
- Draft/completed services, advanced service filters, optional notes, Admin archive management, searchable attendance checklist, live totals, and service visitors
- Stable client-generated UUIDs and durable IndexedDB writes
- Authenticated initial and incremental pull synchronization
- Automatic upload/download synchronization with retry
- Installable PWA shell with safe service-worker updates
- Organization-scoped PostgreSQL schema with validation, indexes, foreign keys, and RLS
- Optional fictional local development seed members

## Local setup

Requirements: Node.js 22.13 or newer, npm, and a Supabase project.

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env.local`.
3. Run these files in Supabase SQL Editor in filename order:

   - `supabase/migrations/202607290001_stage_one.sql`
   - `supabase/migrations/202607290002_sync_timestamps.sql`
   - `supabase/migrations/202607290003_user_roles_and_record_lifecycle.sql`
   - `supabase/migrations/202607290004_inactive_member_metadata.sql`
   - `supabase/migrations/202607290005_fix_people_lifecycle_rls.sql`
   - `supabase/migrations/202607290006_service_visitor_lifecycle.sql`
   - `supabase/migrations/202607290007_allow_privileged_dashboard_administration.sql`
   - `supabase/migrations/202607290008_application_settings.sql`
   - `supabase/migrations/202607290009_bidirectional_reconciliation.sql`
   - `supabase/migrations/202607290010_unnamed_visitor_count.sql`
   - `supabase/migrations/202607290011_append_only_audit_log.sql`
   - `supabase/migrations/202607300001_bulk_member_entry.sql`
   - `supabase/migrations/202607300002_account_recovery_contacts_and_visitors.sql`
   - `supabase/migrations/202607300003_advanced_service_management.sql`
   - `supabase/migrations/202607300004_intelligent_member_management.sql`
   - `supabase/migrations/202607300005_fix_audit_log_sync.sql`
   - `supabase/migrations/202607300006_secure_user_account_deletion.sql`

4. Create the first user and organization using the steps below.
5. Put the project URL, browser-safe anon key, and server-only service-role key in `.env.local`. The service-role key must never have a `NEXT_PUBLIC_` prefix.
6. Start development with `npm run dev`.

Useful checks:

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm audit --omit=dev
```

## Environment variables

| Variable | Value and exposure |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Existing Supabase project URL; browser-safe |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Existing anon/publishable key; browser-safe and protected by RLS |
| `NEXT_PUBLIC_ENABLE_DEMO_SEED` | `false` in production |
| `SUPABASE_SERVICE_ROLE_KEY` | Existing service-role key; server-only |

The service-role key is used only after an Admin API route verifies the caller's Supabase access token and active Admin profile. Never paste it into source code, chat, a client-side variable, or GitHub.

## Create the first organization and Admin

1. In **Supabase > Authentication > Users**, add the first user with email and password.
2. Copy that user's Auth UUID.
3. Open `supabase/bootstrap-first-organization.sql` and replace its clearly marked placeholders.
4. Run the edited block once in Supabase SQL Editor.
5. Sign in through `/login`.

The bootstrap script is for the first organization only. Invitations and the fallback workflow below always reuse that organization.

## User roles and permissions

| Capability | Admin | Attendance Taker |
| --- | --- | --- |
| View people, services, and attendance | Yes | Yes |
| Add members and edit basic member names | Yes | Yes |
| Create services and record attendance/visitors | Yes | Yes |
| Archive, restore, or remove members | Yes | No |
| Edit, archive, or remove services | Yes | No |
| Invite users, change roles, disable/restore access | Yes | No |
| Open User Management or organization Settings | Yes | No |

Interface checks improve clarity, but are not the security boundary. RLS limits every user to their active organization. Database triggers reject Attendance Taker lifecycle operations. User/profile administration is performed only through server routes that independently verify an active Admin.

### Add an Attendance Taker

1. Apply `202607290003_user_roles_and_record_lifecycle.sql`.
2. Add `SUPABASE_SERVICE_ROLE_KEY` to the local or Vercel server environment. Never prefix it with `NEXT_PUBLIC_`.
3. Add the invitation redirect URLs listed below in Supabase.
4. Sign in with the existing Admin account and open **Settings > Users**.
5. Select **Invite user**, enter the person's display name and email, choose **Attendance Taker**, and send the invitation.
6. The invited person opens the email link while online, chooses a password, and completes their first sign-in online.
7. Wait for **Synced** on the new device before testing offline use.

The profile is attached automatically to the Admin's existing organization. No new organization is created.

If invitation email delivery is unavailable, create and confirm the additional user in **Supabase > Authentication > Users**, then run `supabase/add-existing-user-to-organization.sql`. Replace its placeholders with the existing Admin Auth UUID, the new user's Auth UUID, and a display name. The SQL derives the organization from the existing Admin and will not create another organization. The new user must still sign in online once on each new device.

## Supabase authentication URLs

In **Supabase > Authentication > URL Configuration**, configure:

- Site URL: `https://<assigned-production-domain>.vercel.app`
- Production login redirect: `https://<assigned-production-domain>.vercel.app/login`
- Production invitation redirect: `https://<assigned-production-domain>.vercel.app/accept-invite`
- Production password-recovery redirect: `https://<assigned-production-domain>.vercel.app/reset-password`
- Local login redirect: `http://localhost:3000/login`
- Local invitation redirect: `http://localhost:3000/accept-invite`
- Local password-recovery redirect: `http://localhost:3000/reset-password`

The default Vercel domain is sufficient. Use the exact stable production domain Vercel assigns. Add preview wildcards only if preview authentication is genuinely needed.

## Private Vercel deployment checklist

1. Confirm all seventeen migrations were applied in filename order.
2. Confirm the first Admin and organization profile exist.
3. Confirm `.env.example` contains placeholders and `.env.local` is untracked.
4. Import the existing `alsussex/Alupc-attendance` repository and select `main`.
5. Use the Next.js preset, repository root, default install command, and `npm run build`.
6. Add the four environment variables above; set demo seed to `false`.
7. Deploy, copy the assigned production domain, and configure the exact Supabase URLs.
8. Enable Vercel Deployment Protection if desired for private testing.
9. Sign in, wait for **Synced**, and use fictional records for verification.

## Offline and synchronization architecture

```text
Screen -> repository -> IndexedDB transaction -> mutation queue
                                                   |
                                                   v
                                                Supabase
                                                   |
                                                   v
                    authenticated pull -> safe IndexedDB merge -> screen
```

- UI writes never wait for Supabase. Repositories write IndexedDB first and queue an idempotent upsert.
- `lib/storage/database.ts` defines the durable local stores.
- `lib/sync/queue.ts` coalesces repeated upserts for the same record.
- Upload and pull remain separate, testable operations and run in dependency order.
- Sync runs after login/startup, shortly after every local change, on reconnection/focus, after a Realtime notification, every 30 seconds while open and online, and after capped exponential retry delays. Rapid mutations are coalesced per stable record ID before upload.
- Queue insertion emits a dedicated mutation event, so automatic synchronization does not depend on a general UI refresh event. Startup, focus, reconnection, and manual sync also recover failed entries and processing entries stale for more than two minutes.
- Client UUIDs remain stable locally and in Supabase.
- Cache Storage holds only the application shell; IndexedDB holds church records and pending mutations. A service-worker update does not delete IndexedDB.

## Application settings

Admins open **Settings** from the main navigation. Attendance Takers do not see
the entry, and the route guard redirects direct access. Settings are grouped into
General, Services, Attendance, Visitors, Users, Data & Export, Device & Sync,
and Security.

Migration `202607290008_application_settings.sql` creates one
`organization_settings` row per organization, adds optional service times and
visitor notes, and applies organization-scoped RLS. Organization members may
read workflow settings required by Services; only an active Admin may insert or
update them. The migration also replaces the former fixed service-type check
with bounded text validation so Admin-defined service types can synchronize.

Organization-wide workflow settings save to IndexedDB first, use the
organization UUID as their stable record ID, and enter the existing idempotent
mutation queue. This makes attendance sorting, counters, inactive-member
visibility, visitor behavior, and new-service defaults available offline after
the first successful synchronization. New default service times apply only to
new services; historical service rows are not rewritten.

CSV exports are available for members, inactive members, services, attendance,
and visitors. Service-related exports include `members_present`,
`named_visitor_count`, `unnamed_visitor_count`, `visitor_total`, and
`total_present`. The JSON backup includes the same values in
`serviceAttendanceSummaries` alongside the organization-scoped application
records, but excludes sessions, passwords, access/refresh tokens, invitation
tokens, environment variables, and synchronization diagnostics. These
summaries provide reporting-ready historical totals without changing completed
service records. Import/restore and permanent organization deletion are
explicitly unavailable in this release.

User invitations and role management now live at **Settings > Users**. Invites,
role changes, access changes, password reset, and global sign-out remain
online-only security operations. **Device & Sync** can invoke the real sync
processor, refresh cloud data only when no local writes are waiting, or clear
this browser's data after explicit warnings. Clearing local data never deletes
Supabase records.

### First sign-in and offline reopening

A user must sign in online once on each new device. A successful sign-in stores the Supabase session and a small local profile cache. Thereafter, a previously authorized device can reopen offline and use its synchronized IndexedDB data. A brand-new user cannot authenticate for the first time while offline, and the login screen explains this limitation.

Disabling an account takes effect immediately for online database/API access. A device that is already offline cannot learn it was disabled until it reconnects. On reconnection, session/profile revalidation and RLS remove access.

### Initial and incremental pull

After login, the profile identifies the active organization. The coordinator uploads pending writes, then downloads organization/profile parents, people/services, and finally attendance/visitors. A fresh browser downloads all permitted records.

Each user, organization, and table stores its own durable `updated_at` cursor. Later pulls use deterministic `updated_at, id` pagination from an inclusive cursor. Repeated boundary rows are safe because IndexedDB upserts are idempotent. A cursor advances only after a complete table pull.

### Remote changes and session recovery

Migration `202607290009_bidirectional_reconciliation.sql` adds monotonically
increasing server record versions and idempotent mutation receipts to every
locally writable synchronized table. It also enables the synchronized tables in
the Supabase Realtime publication with organization-filtered subscriptions.
Realtime accelerates detection; incremental polling remains the durable fallback
for missed websocket events and direct Table Editor or SQL Editor changes.

Migration `202607290010_unnamed_visitor_count.sql` adds a constrained unnamed
visitor count to each service. The count uses the same local-first service
record, UUID, version checks, mutation queue, RLS, and realtime reconciliation;
it does not create placeholder visitor records.

The attendance workspace deliberately presents one combined **Visitors** total:
named service-only visitors plus the service's unnamed visitor count. The
running **Total Present** is members present plus that combined visitor total.
Named visitors remain editable service records; unnamed visitors remain only an
aggregate count on the service. Completed services preserve both forms with the
original service and attendance UUIDs.

Supabase continues refreshing tokens automatically. The authentication provider
also handles `SIGNED_IN`, `TOKEN_REFRESHED`, and `SIGNED_OUT` explicitly,
reloads the active profile and organization after refresh, and reinitializes
synchronization when the user, role, access state, or organization changes.
An authentication-related upload or download failure gets one session/profile
refresh and one retry. A failed refresh never removes IndexedDB mutations and
does not recurse indefinitely.

At startup, a healthy persisted session is restored without unnecessarily
rotating its refresh token. Only an expired token or a confirmed authentication
failure forces recovery. Profile and organization errors are treated as access
loading failures rather than invalid sessions; a previously authorized device
falls back to its IndexedDB profile and organization while remote access is
retried three times with bounded delays. RLS authorization failures remain sync
errors and do not trigger sign-in repair. Authentication diagnostics log the
phase, error code/status, and safe account identifiers without logging access or
refresh tokens.

The complete reconciliation order is: recover queue locks, upload pending
parents and children in dependency order, pull organization-scoped updates,
merge records without pending local writes, notify the interface, and store
per-user synchronization metadata. **Sync now** performs this same full
bidirectional process. **Settings > Device & Sync > Repair local sync state**
refreshes authentication and rebuilds remote cached copies only when no local
writes are pending.

### Organization-wide draft editing

A draft is an organization record, never a private browser or creator record.
`created_by` is retained only for audit history. The services SELECT policy and
every pull query are scoped by `organization_id`, so Admins and Attendance
Takers in the same church receive the same service UUID, status, attendance
rows, named visitors, and unnamed visitor count.

Draft discovery runs at startup and sign-in, after token refresh, on browser
focus, on network reconnection, after an organization-filtered Realtime event,
after each successful upload, through **Sync now**, and through the 30-second
incremental reconciliation fallback. A pull announces a local data change, so
an open Services or attendance screen refreshes from IndexedDB without a page
reload. Realtime is an accelerator; the durable cursor-based pull is the source
of recovery after a missed event or direct Supabase edit.

Service, person, visitor, and attendance mutations use stable IDs. Attendance
uses the canonical `serviceId:personId` local key plus the database unique
constraint on organization/service/person. Retries therefore update the same
records rather than creating a second draft or attendance row. The Services
directory derives **Synced**, **Sync pending**, **Uploading**, or **Conflict**
from the service and all of its dependent queued mutations. Attendance Takers
see the non-technical **Needs attention** wording for a conflict.

Completion is a one-way precedence rule during ordinary reconciliation. If a
stale pending Draft meets a newer Completed server version, IndexedDB adopts
Completed and rewrites the queued service mutation against that current base
version while preserving pending attendance and visitors. Only an Admin using
the explicit, permitted reopen workflow against the current version can reopen
a completed service.

### Save and sync feedback

Routine changes—including attendance checkboxes, people, visitors, service details, and member reactivation—update IndexedDB immediately and synchronize quietly. Normal online work keeps a stable **Online** indicator instead of flashing between syncing states. A subtle pending indicator appears only when queued work remains longer than the normal background-sync window.

**Save Draft** and **Finish Service** are the two explicit confirmation actions. They temporarily show **Saving…**, attempt an immediate sync after the local write, and then confirm the cloud or offline result.

The prominent sync bar appears only when useful:

- Offline, including the number of durable queued records
- Reconnecting while saved changes are uploading
- Briefly after recovery with **All changes synced**
- After three consecutive online failures, while automatic retry continues

**Sync now** remains a troubleshooting fallback. It immediately invokes the real upload/pull processor, bypasses scheduled retry delays, and safely resets failed or stale processing entries. It is never required during normal attendance entry.

### Conflict resolution and data safety

- A record with a pending local mutation is never overwritten by a pull.
- Otherwise, the newest valid cloud record wins using Supabase-managed `updated_at`.
- Updates use the server `version` as an optimistic-concurrency base. A remote
  version change prevents a stale device from overwriting it; the local
  mutation remains queued with a visible Admin diagnostic.
- A stable per-payload mutation receipt makes retries idempotent even when the
  browser did not receive the first successful response.
- Stable UUID upserts prevent duplicate people, services, and visitors.
- Attendance is canonicalized by service/person; the unique `(organization_id, service_id, person_id)` constraint prevents duplicates.
- Attendance conflicts compare the meaningful `present` value, not
  `version`, `updated_at`, or mutation-receipt metadata. If Supabase already
  contains the queued checkbox state, the device adopts the server version and
  removes the mutation as satisfied. If only server metadata changed, the
  local edit is safely rebased onto the current server version.
- A genuinely different attendance state without a trustworthy shared base is
  retained once as `conflict`. Automatic runs continue syncing other records
  but do not attempt that mutation again, so its attempt counter cannot loop
  indefinitely. A new deliberate checkbox edit replaces and requeues it.
- Queue entries retain errors and attempt counts. Failed pulls retain the prior cursor. Work is never silently discarded.
- Member and service removal uses synchronized tombstone fields, preserving historical references and allowing other devices to hide removed rows.
- Removing a service visitor uses a `deleted_at` tombstone. This removes only the service entry; a linked permanent member and their historical records remain intact.
- Member reactivation updates the existing UUID in place, clears its inactivity timestamp, and leaves every historical attendance row attached.
- Conflict resolution is remote-authoritative when no local write is pending
  and optimistic-concurrency protected when both sides changed the same record.
  Conflicting local work is retained rather than guessed away. Visitor
  conflicts have field-level Admin review; other record conflicts expose the
  entity, record ID, attempt count, and error under Device & Sync.

### People lifecycle RLS and queued recovery

People synchronize with `INSERT ... ON CONFLICT DO UPDATE`. PostgreSQL evaluates the people INSERT policy even for an existing-row update. Migration `202607290005_fix_people_lifecycle_rls.sql` therefore has role-specific insert/upsert and update policies: Admins may upload valid active or inactive versions of existing organization members, while Attendance Takers may upsert only active members and the lifecycle trigger rejects any attempt to change lifecycle, organization, type, or creation ownership fields.

The general people SELECT policy includes active and inactive rows in the authorized organization because PostgreSQL also requires SELECT access for updates and returned rows. The interface remains responsible for deciding which role sees inactive-member controls.

A mutation that previously failed RLS remains in IndexedDB with `error` status. Applying the corrective migration is sufficient: the open app retries on its existing backoff schedule, reconnection, focus, or a new mutation. Reopening the app also retries it. **Sync now** is available as a secondary fallback; the member must not be recreated.

### Permanent audit history

Migration `202607290011_append_only_audit_log.sql` creates the
organization-scoped `audit_log` table. Each entry captures the actor snapshot,
role, UTC occurrence time, entity, action, device identifier when available,
and meaningful before/after details. Database triggers reject every UPDATE and
DELETE, so application users cannot rewrite history. RLS permits active
organization users to append only entries attributed to themselves; only
Admins may read the organization history.

Audit entries are written to IndexedDB beside the domain change and placed in
the existing idempotent mutation queue. They survive browser closure, upload
after reconnection, download through Realtime and the incremental polling
fallback, and use stable UUIDs to prevent duplicate entries. Audit metadata is
not counted as an extra user-facing pending change, although it remains part of
the synchronization run.

Admins can open **Settings > Audit History** to search by user, action, entity,
or details and filter by date and entity type. Results load newest-first in
bounded pages. Service, member, visitor, and user screens expose scoped history
views. CSV and JSON audit exports include timestamps, user and role snapshots,
actions, entities, device identifiers, and details; they contain no
authentication credentials.

### Bulk member entry and intelligent restoration

Authorized Admins and Attendance Takers can select **Add Multiple Members** in
the People directory. The primary format is one `First name Last name` entry
per line; the first word becomes the first name and all remaining words remain
together as the last name. Single-word names and `Last name, First name` are
also accepted. Names are parsed and reviewed locally before any record is
created.

The preview performs an organization-scoped, case-insensitive exact normalized
match against active, inactive, and soft-deleted member records. Active matches
are skipped, one inactive or removed match is offered for restoration, and
multiple matches require an explicit selection or **Create separate person**.
Restoration preserves the existing UUID, creation date, attendance history,
and relationships. Confirmed rows use the ordinary IndexedDB-first repository
and mutation queue, so bulk entry works offline and retries idempotently after
reconnection. The unfinished entry/review draft is retained on the authorized
device until the operation is completed.

Migration `202607300001_bulk_member_entry.sql` permits blank last names, stores
an indexed normalized name, and uses a transaction-scoped advisory lock to
prevent concurrent devices from accidentally creating the same active member.
Existing duplicate names are preserved and are never merged automatically.
The migration permits Attendance Takers only the safe inactive/removed →
active restoration transition; deactivation, archival, deletion, organization
changes, and creation ownership changes remain blocked.

## Account recovery, direct user creation, and member contact details

The sign-in page can request a Supabase password-recovery email without
revealing whether an account exists. Recovery links return to
`/reset-password`; invitation links return to `/accept-invite`. Both routes
exchange the callback code, require matching password confirmation, and handle
expired or reused links without entering the protected application.

For the production project, Supabase **Authentication → URL Configuration**
must use `https://alupc-attendance.vercel.app` as the Site URL and include these
exact Redirect URLs:

- `https://alupc-attendance.vercel.app/reset-password`
- `https://alupc-attendance.vercel.app/accept-invite`
- `http://localhost:3000/reset-password`
- `http://localhost:3000/accept-invite`

Keep the standard recovery email action linked through
`{{ .ConfirmationURL }}`. A customized template must preserve Supabase's
confirmation URL or use `{{ .RedirectTo }}` correctly; a link containing only
`{{ .SiteURL }}` does not carry a recovery credential. The application also
detects valid recovery credentials that Supabase returns to the Site URL and
forwards them safely to `/reset-password`.

The recovery form recognizes Supabase email rate limits, shows a clear
temporary-limit message, and prevents immediate repeat requests on the same
device. It continues to use a privacy-safe success message that does not reveal
whether an email address has an account. Supabase's built-in email provider is
intended for testing and has a very small project-wide sending allowance.
Configure **Authentication → Email → SMTP Settings** with a trusted SMTP
provider before relying on password recovery in production; application code
cannot safely bypass an email-provider quota.

Settings → Users separates **Invite User** from **Create User**. Direct account
creation calls the authenticated `/api/admin/users` server route. The route
verifies the caller's access token, reloads the active Admin profile, derives
the organization from that profile, and only then uses
`SUPABASE_SERVICE_ROLE_KEY` on the server. Passwords and privileged credentials
are never stored in IndexedDB, returned to the browser, or copied into audit
details.

Migration
`202607300002_account_recovery_contacts_and_visitors.sql` must be applied after
`202607300001_bulk_member_entry.sql`. It adds optional member email and phone
fields, permits an empty visitor last name while retaining a required first
name, and creates `member_private_details` for Admin-only notes. Email and phone
follow the existing trusted member-edit permission used by Admins and
Attendance Takers. Administrative notes have separate Admin-only RLS, offline
storage, synchronization, backup/export support, and audits that record only
that notes changed—not their text.

### Known limitations

- Sync and Realtime reconciliation run while the app is open. There is no
  operating-system background sync or push notification after the browser has
  been fully closed.
- The application supports one active organization per profile and no organization switching.
- Invitation resend depends on Supabase Auth email delivery and rate limits.
- Last-sign-in information is available only through the server-only Auth Admin API.
- Device clocks timestamp an initial local version; pending-write protection preserves it until Supabase assigns the trusted server timestamp.

## PWA deployment behavior

- Navigations use network-first caching so online clients detect a new deployment.
- The browser checks the service worker on registration, focus, reconnection, and hourly.
- Activation removes only old Church Attendance shell caches.
- Service-worker activation does not delete IndexedDB records, pending writes, or cursors.
- Cross-origin Supabase authentication and synchronization requests are never cached.

## Optional fictional seed data

Set `NEXT_PUBLIC_ENABLE_DEMO_SEED=true` only in local development. When no active members exist, the app adds Jack Black, Chris Cummings, and Taylor Swift. Disable the flag to stop seeding; existing fictional seed rows remain ordinary member records.

## Project structure

```text
app/                         Next.js pages and Admin API routes
components/auth/             session and protected/Admin route guards
components/dashboard/        dashboard
components/people/           member directory
components/services/         services, attendance, and visitors
components/users/            Admin-only user management
components/shell/            responsive navigation and sync status
components/sync/             startup and automatic synchronization
components/audit/            Admin-only paginated audit history views
components/pwa/              service-worker registration
lib/auth/                    role permission helpers
lib/repositories/            local-first domain repositories
lib/audit/                   local-first audit recording, filtering, and export
lib/storage/                 IndexedDB schema and data events
lib/sync/                    queue, upload, pull, conflict, and retry services
lib/supabase/                browser client and server-only Admin authorization
supabase/migrations/         schema, RLS, timestamps, and role enforcement
tests/                       behavior, synchronization, security, and production checks
```

## Intentionally unfinished

This release does not include Excel export, charts, import/restore, permanent organization deletion, advanced field-level conflict editing, service-worker background sync, push notifications, visitor conversion after a service, or multi-organization switching.

## Two-device manual verification

Use fictional data such as **Alex Meadow** and **Robin Field**.

1. Apply all seventeen migrations and configure the same Supabase project.
2. Open Browser A as Admin, wait for **Online**, invite a fictional Attendance Taker, and complete that user's first sign-in online in Browser B.
3. In Browser A, add Alex Meadow, create a draft service, check Alex present, and allow background sync to complete.
4. In Browser B, focus the app and confirm Alex, the service, and attendance total of one.
5. Take Browser B offline. Add Robin Field or change attendance. Confirm the offline bar reports the queued change count, close the browser, reopen it while still offline, and verify the change remains.
6. Restore connectivity and confirm **Back online — syncing…**, followed briefly by **All changes synced.** Use **Sync now** only as a backup.
7. Focus Browser A and confirm Browser B's change appears exactly once.
8. Uncheck and recheck one attendee and synchronize both browsers; confirm no duplicate attendance row and the total is correct.
9. As the Attendance Taker, confirm `/settings` redirects to the dashboard and direct archive/delete requests are rejected. `/users` is a legacy redirect into the protected Settings route.

### Simultaneous-client reconciliation check

1. Keep the Members page open in Client A and sign in to Client B for the same
   organization.
2. In Client B, rename one fictional member, make another inactive, edit
   attendance, then add and remove a fictional service visitor.
3. Confirm Client A updates through Realtime or within 30 seconds without
   clearing cookies, IndexedDB, or reloading the whole application.
4. Edit a fictional member directly in Supabase Table Editor. Confirm both
   clients receive the server-managed `updated_at` and `version` change.
5. Take Client B offline, make a different local change, close and reopen it,
   then reconnect. Confirm the mutation uploads once and both clients reconcile.
6. To test conflict safety, edit the same fictional member on both clients while
   one is offline. The stale client must retain its queued change and show an
   Admin diagnostic instead of overwriting the newer server version.
