# Church Attendance

Stage-one foundation for an offline-capable church attendance Progressive Web App. Authorized users can maintain an active member directory, create services, record attendance by name, and add one-time visitors. Changes are written to IndexedDB first and queued for Supabase synchronization.

## What is included

- Supabase email/password login with persistent sessions and no public registration
- Protected Dashboard, People, Services, and Settings routes
- Active-member search, create, edit, duplicate-name warning, and soft deactivation
- Draft/completed services with the five requested service types
- Searchable, touch-friendly attendance checklist with a live total
- One-service visitors, optionally promoted to members
- Stable client-generated UUIDs
- IndexedDB stores for people, services, attendance, visitors, and the sync queue
- Automatic synchronization attempts when connectivity returns
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
3. In Supabase, open the SQL editor and run `supabase/migrations/202607290001_stage_one.sql`.
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
5. Run the edited block once in the Supabase SQL editor.
6. Sign in through `/login`.

For each future authorized user, create the authentication user and insert one `profiles` row pointing to the correct `organization_id`. The stage-one UI intentionally does not include user administration.

## Optional fictional seed data

Set this only in local development:

```env
NEXT_PUBLIC_ENABLE_DEMO_SEED=true
```

When the organization has no active members, the app adds Jack Black, Chris Cummings, and Taylor Swift. Turn the flag off to remove the seeding behavior. Existing seed records remain ordinary member records and can be marked inactive.

## Offline and synchronization architecture

The data flow is intentionally local-first:

```text
Screen → typed repository → IndexedDB transaction → sync queue
                                               ↓
                                    Supabase when online
```

- UI components do not call Supabase for writes.
- `lib/repositories/attendance-repository.ts` owns local domain writes.
- `lib/storage/database.ts` defines the versioned IndexedDB schema.
- `lib/sync/queue.ts` coalesces repeated upserts for the same record.
- `lib/sync/sync-service.ts` retries pending operations when the browser returns online.
- Record IDs are generated on the client. The same IDs are used locally and in Supabase.
- The service worker caches the previously loaded application shell. IndexedDB holds product records; the service-worker cache is not treated as data storage.

The sync indicator means:

- **Online and synced** — no local queue entries remain.
- **Saved locally** — the device is offline or data is currently device-local.
- **Sync pending** — queued writes are waiting for or attempting cloud sync.
- **Sync error** — Supabase rejected at least one queued write; tapping the indicator retries.

### Temporary stage-one conflict strategy

Sync uses idempotent upserts. For the same record ID, the most recently synchronized `updated_at` payload wins at the row level. Repeated attendance submissions use the organization/service/person unique key, preventing duplicate attendance rows. Failed writes remain in the queue with their error and attempt count; they are never silently discarded.

This is deliberately simple. Stage two should add pull synchronization, server-version checks, tombstones, deterministic field-level conflict rules, and an administrator-facing conflict review experience.

## Database and security notes

- Every product table carries `organization_id`.
- Composite foreign keys ensure attendance and visitors cannot reference records from another organization.
- RLS resolves the current organization through the authenticated user’s active profile.
- Authenticated users may select/insert/update only records in their organization.
- No permanent-delete policy is granted for stage-one people or service data.
- The browser uses only the anon key. RLS remains the authorization boundary.

## Project structure

```text
app/                         Next.js routes, layout, and global styling
components/auth/             session provider and protected-route guard
components/shell/            responsive navigation and sync status
components/people/           member directory workflow
components/services/         services, attendance, and visitor workflows
components/pwa/              service-worker registration
lib/domain.ts                shared types, IDs, names, and totals
lib/repositories/            local-first domain repositories
lib/storage/                 IndexedDB schema
lib/sync/                    queue and online retry service
lib/supabase/                browser Supabase client
lib/seed/                    optional fictional seed
public/                      manifest, service worker, and icons
supabase/migrations/         stage-one cloud schema and RLS
tests/                       focused behavior tests
```

## Intentionally unfinished

This stage does not include Excel export, reporting, charts, user administration, invitations, advanced conflict resolution, push notifications, detailed person profiles, bulk operations, visitor conversion after a service, or multi-organization switching. Pull synchronization and background sync are also future work; this foundation currently pushes queued local changes when the app is open and connectivity is restored.
