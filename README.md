# Church Attendance

Stage 1.5 foundation for an offline-capable church attendance Progressive Web App. Authorized users can maintain an active member directory, create services, record attendance by name, and add one-time visitors. Changes are written to IndexedDB first, uploaded to Supabase, and pulled onto other authorized devices.

## What is included

- Supabase email/password login with persistent sessions and no public registration
- Protected Dashboard, People, Services, and Settings routes
- Active-member search, create, edit, duplicate-name warning, and soft deactivation
- Draft/completed services with the five requested service types
- Searchable, touch-friendly attendance checklist with a live total
- One-service visitors, optionally promoted to members
- Stable client-generated UUIDs
- IndexedDB stores for organizations, profiles, people, services, attendance, visitors, synchronization cursors, and the upload queue
- Initial and incremental authenticated pull synchronization from Supabase
- Automatic synchronization at startup, on focus, periodically, and when connectivity returns
- PWA manifest and an application-shell service worker
- Organization-scoped PostgreSQL schema with validation, indexes, foreign keys, and RLS
- Optional fictional development seed members

## Local setup

Requirements: Node.js 22.13 or newer, npm, and a Supabase project.

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env.local`.
3. In Supabase SQL Editor, run these migrations in filename order:
   - `supabase/migrations/202607290001_stage_one.sql`
   - `supabase/migrations/202607290002_sync_timestamps.sql`
4. Create the first user and organization using the steps below.
5. Put the project URL and browser-safe anon key in `.env.local`. Never use the service-role key in this app.
6. Start development:

   ```bash
   npm run dev
   ```

Useful checks:

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm audit --omit=dev
```

## Create the first organization and authorized user

1. In the Supabase dashboard, open **Authentication → Users → Add user**.
2. Create the user with email and password. Do not add a public sign-up flow.
3. Copy the new user UUID.
4. Open `supabase/bootstrap-first-organization.sql` and replace:
   - `REPLACE_WITH_AUTH_USER_UUID`
   - `REPLACE WITH CHURCH NAME`
   - `replace-with-church-slug`
   - `REPLACE WITH USER NAME`
5. Run the edited block once in Supabase SQL Editor.
6. Sign in through `/login`.

For each future authorized user, create the authentication user and insert one `profiles` row pointing to the correct `organization_id`. Stage 1.5 intentionally does not include user administration.

## Optional fictional seed data

Set this only in local development:

```env
NEXT_PUBLIC_ENABLE_DEMO_SEED=true
```

When the organization has no active members, the app adds Jack Black, Chris Cummings, and Taylor Swift. Turn the flag off to disable seeding. Existing seed records remain ordinary member records and can be marked inactive.

## Offline and synchronization architecture

The data flow remains local-first:

```text
Screen -> typed repository -> IndexedDB transaction -> upload queue
                                                        |
                                                        v
                                                     Supabase
                                                        |
                                                        v
                         authenticated pull -> safe IndexedDB merge -> screen
```

- UI components do not call Supabase for writes.
- `lib/repositories/attendance-repository.ts` owns local domain writes.
- `lib/storage/database.ts` defines the versioned IndexedDB schema.
- `lib/sync/queue.ts` coalesces repeated upserts for the same record.
- `lib/sync/upload-service.ts` uploads queued changes in dependency order.
- `lib/sync/pull-service.ts` downloads and merges cloud changes in dependency order.
- `lib/sync/sync-service.ts` coordinates the separate upload and pull operations.
- Client-generated UUIDs remain stable locally and in Supabase.
- The service worker caches the previously loaded application shell. IndexedDB holds product records; the service-worker cache is not treated as data storage.

### Initial pull synchronization

After login, the authenticated profile identifies the active organization. The coordinator first attempts to upload pending local writes, then downloads the permitted organization and profile, followed by people and services, then attendance and visitors. Parent records therefore exist locally before dependent records. A new browser with no cursors downloads every available record and the interface refreshes from IndexedDB as each table is safely merged.

Row Level Security remains the authorization boundary. Pull queries are organization-scoped, and the merge layer also rejects any row whose organization does not match the authenticated profile.

### Incremental synchronization

Each successfully downloaded table has its own `updated_at` cursor in IndexedDB. Later pulls request records at or after that cursor and paginate in deterministic `updated_at`, `id` order. The inclusive boundary makes equal-timestamp rows safe to repeat, and IndexedDB upserts make the operation idempotent. A cursor advances only after the entire table download completes, so a temporary failure cannot skip partially downloaded data.

Synchronization runs after login, when the app starts, when it regains connectivity, when its window regains focus, and periodically while it remains open. The app continues to use the last synchronized IndexedDB data while offline.

The visible synchronization states are:

- **Loading church data** — preparing the local repository after login.
- **Downloading updates** — uploading pending writes or pulling cloud changes.
- **Sync complete** — the pull completed and no upload error remains.
- **Sync pending** — local writes remain queued.
- **Sync error** — an upload or pull failed; use **Retry sync** after correcting connectivity or configuration.
- **Offline — using saved data** — the app is reading previously synchronized IndexedDB data.

### Conflict-resolution behavior

- A record with a pending local upload is never overwritten by a cloud pull.
- Otherwise, the current cloud record is authoritative because the Stage 1.5 migration makes its `updated_at` server-managed on both insert and update. An untrusted device clock never outranks the server clock.
- Stable UUID upserts prevent duplicate people, services, and visitors.
- Attendance is canonicalized by service/person, and the database unique constraint on `(organization_id, service_id, person_id)` prevents duplicate attendance rows.
- Failed uploads stay in the queue with their error and attempt count. Failed pulls keep the previous table cursor. Neither path silently discards work.
- Upload and pull are separate, directly testable operations. The coordinator uploads first so a device's pending writes are protected before it downloads updates.

### Known synchronization limitations

- Synchronization runs while the app is open; it does not use background sync, push notifications, or Supabase Realtime.
- Conflict handling is record-level, not field-level, and there is no administrator conflict-review screen.
- Permanent deletion is intentionally unsupported, so deletion tombstones are not implemented.
- The application supports one active organization per profile and does not provide organization switching.
- Device clocks timestamp the initial local version. Pending-write protection prevents a pull from replacing it, while Supabase assigns the trusted timestamp when it is uploaded.

## Database and security notes

- Every product table carries `organization_id`.
- Composite foreign keys ensure attendance and visitors cannot reference records from another organization.
- RLS resolves the current organization through the authenticated user's active profile.
- Authenticated users may select, insert, and update only records in their organization.
- No permanent-delete policy is granted for Stage 1.5 people or service data.
- The browser uses only the anon key. RLS remains the authorization boundary.

## Project structure

```text
app/                         Next.js routes, layout, and global styling
components/auth/             session provider and protected-route guard
components/shell/            responsive navigation and sync status
components/sync/             startup synchronization provider
components/people/           member directory workflow
components/services/         services, attendance, and visitor workflows
components/pwa/              service-worker registration
lib/domain.ts                shared types, IDs, names, and totals
lib/repositories/            local-first domain repositories
lib/storage/                 IndexedDB schema and data-change events
lib/sync/                    separate upload, pull, serialization, and coordination services
lib/supabase/                browser Supabase client
lib/seed/                    optional fictional seed
public/                      manifest, service worker, and icons
supabase/migrations/         cloud schema, RLS, and synchronization timestamps
tests/                       focused behavior, synchronization, and security tests
```

## Intentionally unfinished

This stage does not include Excel export, reporting, charts, user administration, invitations, advanced conflict review, background sync, Supabase Realtime, push notifications, detailed person profiles, bulk operations, visitor conversion after a service, or multi-organization switching.

## Two-device manual verification

Use fictional data only, such as **Alex Meadow** and **Robin Field**.

1. Apply both migrations and configure the same Supabase project in the app.
2. Open Browser A, sign in, wait for **Sync complete**, add fictional member Alex Meadow, create a draft service, check Alex present, and wait for **Sync complete** again.
3. Open a fresh private window or Browser B with no site data. Sign in as an authorized user in the same organization and wait for **Sync complete**.
4. Confirm Alex, the service, and Alex's attendance are visible in Browser B and that the attendance total is one.
5. In Browser B, go offline using browser developer tools. Add fictional member Robin Field or update the draft attendance. Confirm **Offline — using saved data** or **Sync pending**, then reload and verify the local change remains.
6. Restore connectivity and use **Retry sync** if needed. Wait for **Sync complete**.
7. Return to Browser A, focus or reload it, wait for **Sync complete**, and confirm Browser B's change appears exactly once.
8. Uncheck and recheck one attendee, synchronize both browsers again, and confirm the attendance total remains correct and no duplicate attendance entry appears.
9. Optionally create an authorized user in a second test organization. Confirm that user cannot see the first organization's fictional people, services, or attendance.
