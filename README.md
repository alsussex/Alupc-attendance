# Church Attendance

Offline-capable church attendance Progressive Web App for Abundant Life UPC. Authorized users can maintain the member directory, create services, record attendance by name, and add one-time visitors. IndexedDB is the immediate data source; Supabase provides authentication, organization-scoped cloud storage, and multi-device synchronization.

## Included

- Supabase email/password login with persistent per-device sessions and no public registration
- Admin and Attendance Taker roles enforced in the interface, server routes, database triggers, and RLS
- Admin-only invitations, role changes, access suspension/restoration, resend, and pending-invitation cancellation
- Responsive Dashboard, People, Services, Users, and Settings routes
- Active/inactive/all member views, member profiles, search, duplicate-name warning, and Admin lifecycle controls
- Draft/completed services, searchable attendance checklist, live totals, and service visitors
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
4. Sign in with the existing Admin account and open **Users**.
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
- Local login redirect: `http://localhost:3000/login`
- Local invitation redirect: `http://localhost:3000/accept-invite`

The default Vercel domain is sufficient. Use the exact stable production domain Vercel assigns. Add preview wildcards only if preview authentication is genuinely needed.

## Private Vercel deployment checklist

1. Confirm all four migrations were applied in filename order.
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
- Sync runs after login/startup, shortly after every local change, on reconnection/focus, periodically, and after capped exponential retry delays. Rapid mutations are coalesced per stable record ID before upload.
- Client UUIDs remain stable locally and in Supabase.
- Cache Storage holds only the application shell; IndexedDB holds church records and pending mutations. A service-worker update does not delete IndexedDB.

### First sign-in and offline reopening

A user must sign in online once on each new device. A successful sign-in stores the Supabase session and a small local profile cache. Thereafter, a previously authorized device can reopen offline and use its synchronized IndexedDB data. A brand-new user cannot authenticate for the first time while offline, and the login screen explains this limitation.

Disabling an account takes effect immediately for online database/API access. A device that is already offline cannot learn it was disabled until it reconnects. On reconnection, session/profile revalidation and RLS remove access.

### Initial and incremental pull

After login, the profile identifies the active organization. The coordinator uploads pending writes, then downloads organization/profile parents, people/services, and finally attendance/visitors. A fresh browser downloads all permitted records.

Each table stores its own `updated_at` cursor. Later pulls use deterministic `updated_at, id` pagination from an inclusive cursor. Repeated boundary rows are safe because IndexedDB upserts are idempotent. A cursor advances only after a complete table pull.

### Save and sync feedback

Routine changes—including attendance checkboxes, people, visitors, service details, and member reactivation—update IndexedDB immediately and synchronize quietly. Normal online work keeps a stable **Online** indicator instead of flashing between syncing states. A subtle pending indicator appears only when queued work remains longer than the normal background-sync window.

**Save Draft** and **Finish Service** are the two explicit confirmation actions. They temporarily show **Saving…**, attempt an immediate sync after the local write, and then confirm the cloud or offline result.

The prominent sync bar appears only when useful:

- Offline, including the number of durable queued records
- Reconnecting while saved changes are uploading
- Briefly after recovery with **All changes synced**
- After three consecutive online failures, while automatic retry continues

**Sync now** remains a troubleshooting fallback. It is never required during normal attendance entry.

### Conflict resolution and data safety

- A record with a pending local mutation is never overwritten by a pull.
- Otherwise, the newest valid cloud record wins using Supabase-managed `updated_at`.
- Stable UUID upserts prevent duplicate people, services, and visitors.
- Attendance is canonicalized by service/person; the unique `(organization_id, service_id, person_id)` constraint prevents duplicates.
- Queue entries retain errors and attempt counts. Failed pulls retain the prior cursor. Work is never silently discarded.
- Member and service removal uses synchronized tombstone fields, preserving historical references and allowing other devices to hide removed rows.
- Member reactivation updates the existing UUID in place, clears its inactivity timestamp, and leaves every historical attendance row attached.
- Conflict resolution is record-level last-server-write-wins; there is not yet a field-level conflict review screen.

### Known limitations

- Sync runs while the app is open; it does not use background sync, push notifications, or Supabase Realtime.
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
components/pwa/              service-worker registration
lib/auth/                    role permission helpers
lib/repositories/            local-first domain repositories
lib/storage/                 IndexedDB schema and data events
lib/sync/                    queue, upload, pull, conflict, and retry services
lib/supabase/                browser client and server-only Admin authorization
supabase/migrations/         schema, RLS, timestamps, and role enforcement
tests/                       behavior, synchronization, security, and production checks
```

## Intentionally unfinished

This release does not include Excel export, reports, charts, advanced conflict review, background sync, Supabase Realtime, push notifications, detailed person profiles, bulk operations, visitor conversion after a service, or multi-organization switching.

## Two-device manual verification

Use fictional data such as **Alex Meadow** and **Robin Field**.

1. Apply all four migrations and configure the same Supabase project.
2. Open Browser A as Admin, wait for **Online**, invite a fictional Attendance Taker, and complete that user's first sign-in online in Browser B.
3. In Browser A, add Alex Meadow, create a draft service, check Alex present, and allow background sync to complete.
4. In Browser B, focus the app and confirm Alex, the service, and attendance total of one.
5. Take Browser B offline. Add Robin Field or change attendance. Confirm the offline bar reports the queued change count, close the browser, reopen it while still offline, and verify the change remains.
6. Restore connectivity and confirm **Back online — syncing…**, followed briefly by **All changes synced.** Use **Sync now** only as a backup.
7. Focus Browser A and confirm Browser B's change appears exactly once.
8. Uncheck and recheck one attendee and synchronize both browsers; confirm no duplicate attendance row and the total is correct.
9. As the Attendance Taker, confirm `/users` and `/settings` redirect to the dashboard and direct archive/delete requests are rejected.
