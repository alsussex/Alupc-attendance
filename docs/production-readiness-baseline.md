# Production-readiness network baseline

This baseline reflects the client code paths inspected on August 2, 2026. A
"request" below means a Supabase Auth or REST request; Realtime uses one shared
WebSocket channel with organization-scoped table filters.

## Before this optimization

| Workflow | Minimum automatic requests | Code path |
| --- | ---: | --- |
| First login | 12–13 | Password sign-in, session restoration when emitted, profile, organization, then one delta page for each of nine synchronized tables. More pages were requested for tables over 500 rows. |
| Normal cached startup | 12 | Session, profile, organization, then nine table delta checks. |
| Quiet app left open for one hour | 108 | The five-minute fallback ran twelve times and checked all nine tables, even with no changes. |
| Return after five minutes | Up to 12 | Auth revalidation read session/profile/organization and focus reconciliation checked nine tables. Focus plus visibility events were serialized and shared the five-minute pull cooldown. |
| Attendance edits | `2N + 2` typical | Each distinct changed attendance record and its audit entry uploaded independently; coalesced Realtime notifications then pulled the changed attendance and audit tables once each. Queue coalescing already prevented repeated edits to the same record from producing duplicate pending rows. |
| Finish service | Pending uploads + 12 | Manual sync refreshed session/profile/organization and performed a complete nine-table delta reconciliation after uploading pending rows. |
| Monthly/custom export | 3–5 | Exact services, attendance, visitors, active members, and—when needed—historical attendee member rows. Exports were already cloud-authoritative and range-scoped. |

## Automatic triggers found

- Auth revision after sign-in/token refresh: upload-only automatic pass.
- SyncProvider initialization: background delta pull.
- New local mutation: 450 ms debounced upload-only pass.
- Browser focus and visible-tab events: background pull, with a five-minute
  in-memory cooldown.
- Network reconnect: immediate upload plus background pull.
- Periodic fallback: every five minutes.
- Realtime: one organization channel covering organizations, profiles,
  settings, people, member private details, services, attendance, visitors,
  and audit history; events were coalesced for 450 ms and pulled only the
  affected tables.
- Manual Sync Now and Finish Service: forced queue recovery, upload, and full
  bidirectional delta pull.
- Service worker update checks: focus, reconnect, and hourly. These contact the
  application deployment, not Supabase.

## Primary egress sources

1. `audit_log` is append-only and grows indefinitely, but fresh devices pulled
   all historical rows and every device subscribed to every new audit event.
2. The five-minute fallback checked all nine tables, creating 108 REST checks
   per quiet hour per open device.
3. Fresh-device attendance and visitor history is necessarily the next largest
   payload because it supports offline history and multi-device continuity.
4. Profile and organization access checks could coincide with a focus pull,
   producing up to twelve requests after a longer background interval.
5. Attendance uploads are record/version based for safe conflict handling, so
   many different checked members require many small writes. Repeated edits to
   the same member are already coalesced locally.

## Implemented target

- Routine startup/reconnect pulls eight core tables and leaves append-only audit
  history on demand.
- Focus and scheduled reconciliation pull only people, services, attendance,
  and visitors.
- The fallback interval is ten minutes; Realtime remains the primary live
  change signal.
- Audit history performs a targeted delta pull and temporary audit-only
  Realtime subscription only while an Admin is viewing history.
- Manual Sync Now remains a complete nine-table bidirectional reconciliation.
- Development network telemetry records sanitized endpoint paths, counts,
  transfer sizes, status, and timing in memory. It never records query strings,
  headers, tokens, or bodies.

During local development, compare sessions from the browser console with
`window.__churchAttendanceNetwork.summary()` and clear the bounded in-memory
sample with `window.__churchAttendanceNetwork.reset()`. Production collection
is off unless a developer explicitly sets the local preference
`church-attendance-network-telemetry` to `1` on that device.

For a quiet one-hour session, passive REST checks fall from 108 to 24 (about
78% fewer). Startup removes one request but, more importantly, avoids the
unbounded audit-history payload. Actual byte reduction therefore increases as
the audit log grows. Attendance upload safety, explicit manual reconciliation,
and exact cloud-backed exports are unchanged.
