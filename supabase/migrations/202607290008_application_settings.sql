-- Organization-scoped application settings and workflow defaults.
-- Defaults affect new records only; historical services remain unchanged.

alter table public.services
  add column if not exists service_time time;

alter table public.service_visitors
  add column if not exists notes text
  check (notes is null or char_length(notes) <= 2000);

alter table public.service_visitors
  drop constraint if exists service_visitors_first_name_check;
alter table public.service_visitors
  drop constraint if exists service_visitors_last_name_check;
alter table public.service_visitors
  add constraint service_visitors_first_name_length_check
    check (char_length(first_name) <= 100);
alter table public.service_visitors
  add constraint service_visitors_last_name_length_check
    check (char_length(last_name) <= 100);

alter table public.services
  drop constraint if exists services_service_type_check;

alter table public.services
  add constraint services_service_type_length_check
  check (char_length(trim(service_type)) between 1 and 120);

create table if not exists public.organization_settings (
  id uuid primary key,
  organization_id uuid not null unique
    references public.organizations(id) on delete cascade,
  settings jsonb not null check (jsonb_typeof(settings) = 'object'),
  created_by uuid not null references auth.users(id) on delete restrict,
  updated_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (id = organization_id)
);

create index if not exists organization_settings_organization_idx
  on public.organization_settings (organization_id);

drop trigger if exists organization_settings_set_updated_at
  on public.organization_settings;
create trigger organization_settings_set_updated_at
before insert or update on public.organization_settings
for each row execute function public.set_updated_at();

alter table public.organization_settings enable row level security;

drop policy if exists "Users read settings in their organization"
  on public.organization_settings;
create policy "Users read settings in their organization"
on public.organization_settings for select to authenticated
using (organization_id = public.current_organization_id());

drop policy if exists "Admins add settings in their organization"
  on public.organization_settings;
create policy "Admins add settings in their organization"
on public.organization_settings for insert to authenticated
with check (
  id = organization_id
  and organization_id = public.current_organization_id()
  and private.is_admin()
  and created_by = auth.uid()
  and updated_by = auth.uid()
);

drop policy if exists "Admins update settings in their organization"
  on public.organization_settings;
create policy "Admins update settings in their organization"
on public.organization_settings for update to authenticated
using (
  organization_id = public.current_organization_id()
  and private.is_admin()
)
with check (
  id = organization_id
  and organization_id = public.current_organization_id()
  and private.is_admin()
  and updated_by = auth.uid()
);

drop policy if exists "Admins upsert their organization"
  on public.organizations;
create policy "Admins upsert their organization"
on public.organizations for insert to authenticated
with check (
  id = public.current_organization_id()
  and private.is_admin()
);

grant select, insert, update on table public.organization_settings
  to authenticated;

insert into public.organization_settings (
  id,
  organization_id,
  settings,
  created_by,
  updated_by
)
select
  organization.id,
  organization.id,
  '{
    "shortName": "ALUPC",
    "timezone": "America/Moncton",
    "dateFormat": "month_day_year",
    "weekStart": "sunday",
    "serviceTypes": [
      {"id":"sunday-morning","name":"Sunday Morning","defaultTime":"10:30","enabled":true,"system":true},
      {"id":"sunday-evening","name":"Sunday Evening","defaultTime":"18:30","enabled":true,"system":true},
      {"id":"wednesday-bible-study","name":"Wednesday Bible Study","defaultTime":"19:00","enabled":true,"system":true},
      {"id":"special-service","name":"Special Service","enabled":true,"system":true}
    ],
    "defaultServiceStatus": "draft",
    "allowAdminReopenCompleted": true,
    "confirmComplete": true,
    "confirmArchive": true,
    "attendanceSort": "first_name",
    "showAttendanceTotals": true,
    "showPresentCount": true,
    "showAbsentCount": true,
    "showTotalMemberCount": true,
    "warnZeroAttendance": true,
    "showInactiveInAttendance": false,
    "requireVisitorName": true,
    "allowVisitorNotes": true,
    "confirmVisitorRemoval": true,
    "visitorLabel": "Visitor",
    "showVisitorsSeparately": true,
    "includeVisitorsInTotal": true
  }'::jsonb,
  administrator.id,
  administrator.id
from public.organizations as organization
join lateral (
  select profile.id
  from public.profiles as profile
  where profile.organization_id = organization.id
    and profile.role = 'admin'
    and profile.is_active
  order by profile.created_at
  limit 1
) as administrator on true
on conflict (organization_id) do nothing;

-- Attendance Takers may complete services but cannot reopen them. Admin
-- reopening remains controlled by the organization setting in the interface.
create or replace function private.enforce_service_role()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_role public.profile_role;
begin
  if private.is_privileged_database_context() then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  actor_role := private.current_profile_role();
  if actor_role is null then
    raise exception 'Active church access is required';
  end if;

  if actor_role = 'attendance_taker' then
    if tg_op = 'DELETE' then
      raise exception 'Attendance takers cannot delete services';
    end if;
    if tg_op = 'UPDATE' and (
      new.organization_id is distinct from old.organization_id
      or new.is_archived is distinct from old.is_archived
      or new.deleted_at is distinct from old.deleted_at
      or new.created_by is distinct from old.created_by
      or new.created_at is distinct from old.created_at
      or (old.status = 'completed' and new.status = 'draft')
    ) then
      raise exception 'Attendance takers cannot reopen, archive, or remove services';
    end if;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function private.enforce_service_role() from public;
