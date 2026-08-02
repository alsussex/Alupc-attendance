-- Immutable monthly attendance snapshots for insurance and church-office records.

create table if not exists public.monthly_attendance_snapshots (
  id uuid primary key,
  organization_id uuid not null
    references public.organizations(id) on delete restrict,
  month_start date not null,
  snapshot_version integer not null default 1
    check (snapshot_version >= 1),
  status text not null default 'finalized'
    check (status = 'finalized'),
  payload jsonb not null
    check (jsonb_typeof(payload) = 'object'),
  notes text
    check (notes is null or char_length(notes) <= 2000),
  service_count integer not null
    check (service_count >= 0),
  total_attendance integer not null
    check (total_attendance >= 0),
  finalized_by uuid
    references auth.users(id) on delete set null,
  finalized_by_name text not null
    check (char_length(trim(finalized_by_name)) between 1 and 160),
  finalized_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint monthly_attendance_snapshots_month_start_check
    check (month_start = date_trunc('month', month_start)::date),
  constraint monthly_attendance_snapshots_one_month_unique
    unique (organization_id, month_start)
);

create index if not exists monthly_attendance_snapshots_org_month_idx
  on public.monthly_attendance_snapshots (organization_id, month_start desc);

create or replace function private.reject_monthly_snapshot_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception using
    errcode = '42501',
    message = 'Finalized monthly attendance snapshots are immutable';
end;
$$;

revoke all on function private.reject_monthly_snapshot_mutation() from public;

drop trigger if exists monthly_snapshot_reject_update
  on public.monthly_attendance_snapshots;
create trigger monthly_snapshot_reject_update
before update on public.monthly_attendance_snapshots
for each row execute function private.reject_monthly_snapshot_mutation();

drop trigger if exists monthly_snapshot_reject_delete
  on public.monthly_attendance_snapshots;
create trigger monthly_snapshot_reject_delete
before delete on public.monthly_attendance_snapshots
for each row execute function private.reject_monthly_snapshot_mutation();

alter table public.monthly_attendance_snapshots enable row level security;

drop policy if exists "Organization users read finalized monthly snapshots"
  on public.monthly_attendance_snapshots;
create policy "Organization users read finalized monthly snapshots"
on public.monthly_attendance_snapshots for select to authenticated
using (
  organization_id = public.current_organization_id()
  and status = 'finalized'
);

drop policy if exists "Admins finalize monthly snapshots"
  on public.monthly_attendance_snapshots;
create policy "Admins finalize monthly snapshots"
on public.monthly_attendance_snapshots for insert to authenticated
with check (
  organization_id = public.current_organization_id()
  and private.is_admin()
  and finalized_by = auth.uid()
  and status = 'finalized'
  and snapshot_version = 1
);

grant select, insert on table public.monthly_attendance_snapshots
  to authenticated;

-- Snapshot actions are Admin-only and become part of the immutable audit trail.
alter table public.audit_log
  drop constraint if exists audit_log_entity_type_check;
alter table public.audit_log
  add constraint audit_log_entity_type_check check (
    entity_type in (
      'service',
      'attendance',
      'visitor',
      'member',
      'user',
      'settings',
      'report_snapshot'
    )
  );

alter table public.audit_log
  drop constraint if exists audit_log_role_action_check;
alter table public.audit_log
  add constraint audit_log_role_action_check check (
    role = 'admin'
    or (
      (entity_type = 'user' and action = 'invitation_accepted')
      or entity_type in ('attendance', 'visitor')
      or (
        entity_type = 'member'
        and action in ('added', 'edited', 'reactivated', 'restored')
      )
      or (
        entity_type = 'service'
        and action in ('created', 'edited', 'completed')
      )
    )
  );

comment on table public.monthly_attendance_snapshots is
  'Append-only, display-ready official monthly attendance records. Normal application roles cannot update or delete finalized rows.';
comment on column public.monthly_attendance_snapshots.payload is
  'Versioned display snapshot containing service headings, historical names, attendance marks, visitor counts, and service totals.';
