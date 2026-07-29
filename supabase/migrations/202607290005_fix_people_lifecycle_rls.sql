-- Correct people lifecycle RLS for local-first upserts.
--
-- PostgreSQL checks INSERT policies for INSERT ... ON CONFLICT DO UPDATE even
-- when the conflict takes the UPDATE path. The previous INSERT policy required
-- is_active = true, which rejected an Admin's queued inactive row before the
-- UPDATE policy and lifecycle trigger could authorize it.

alter table public.people enable row level security;

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

create or replace function private.people_record_exists_in_organization(
  target_id uuid,
  target_organization_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    target_organization_id = public.current_organization_id()
    and exists (
      select 1
      from public.people
      where id = target_id
        and organization_id = target_organization_id
    )
$$;

revoke all on function private.people_record_exists_in_organization(uuid, uuid)
from public;
grant execute on function private.people_record_exists_in_organization(uuid, uuid)
to authenticated;

drop policy if exists "Users read people in their organization"
on public.people;
drop policy if exists "Users update people in their organization"
on public.people;
drop policy if exists "Users add members in their organization"
on public.people;
drop policy if exists "Admins add or upsert members in their organization"
on public.people;
drop policy if exists "Attendance takers add or upsert active members"
on public.people;
drop policy if exists "Admins update people in their organization"
on public.people;
drop policy if exists "Attendance takers update ordinary member fields"
on public.people;

create policy "Users read people in their organization"
on public.people for select to authenticated
using (
  organization_id = public.current_organization_id()
  and private.current_profile_role() in ('admin', 'attendance_taker')
);

create policy "Admins add or upsert members in their organization"
on public.people for insert to authenticated
with check (
  organization_id = public.current_organization_id()
  and private.is_admin()
  and person_type = 'member'
  and updated_by = auth.uid()
  and (
    private.people_record_exists_in_organization(id, organization_id)
    or (
      created_by = auth.uid()
      and is_active
      and inactive_at is null
      and deleted_at is null
    )
  )
  and (deleted_at is null or not is_active)
  and (not is_active or inactive_at is null)
);

create policy "Attendance takers add or upsert active members"
on public.people for insert to authenticated
with check (
  organization_id = public.current_organization_id()
  and private.current_profile_role() = 'attendance_taker'
  and person_type = 'member'
  and is_active
  and inactive_at is null
  and deleted_at is null
  and updated_by = auth.uid()
  and (
    created_by = auth.uid()
    or private.people_record_exists_in_organization(id, organization_id)
  )
);

create policy "Admins update people in their organization"
on public.people for update to authenticated
using (
  organization_id = public.current_organization_id()
  and private.is_admin()
)
with check (
  organization_id = public.current_organization_id()
  and private.is_admin()
  and person_type = 'member'
  and updated_by = auth.uid()
  and (deleted_at is null or not is_active)
  and (not is_active or inactive_at is null)
);

create policy "Attendance takers update ordinary member fields"
on public.people for update to authenticated
using (
  organization_id = public.current_organization_id()
  and private.current_profile_role() = 'attendance_taker'
)
with check (
  organization_id = public.current_organization_id()
  and private.current_profile_role() = 'attendance_taker'
  and person_type = 'member'
  and updated_by = auth.uid()
);

create or replace function private.enforce_people_role()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_role public.profile_role;
begin
  if auth.role() = 'service_role' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  actor_role := private.current_profile_role();
  if actor_role is null then
    raise exception 'Active church access is required';
  end if;

  if tg_op = 'DELETE' and actor_role = 'attendance_taker' then
    raise exception 'Attendance takers cannot delete church members';
  end if;

  if tg_op = 'UPDATE' and (
    new.organization_id is distinct from old.organization_id
    or new.person_type is distinct from old.person_type
    or new.created_by is distinct from old.created_by
    or new.created_at is distinct from old.created_at
  ) then
    raise exception 'Organization, type, and creation ownership are immutable';
  end if;

  if actor_role = 'attendance_taker'
    and tg_op = 'UPDATE'
    and (
      new.is_active is distinct from old.is_active
      or new.inactive_at is distinct from old.inactive_at
      or new.deleted_at is distinct from old.deleted_at
    )
  then
    raise exception 'Attendance takers may edit member names but cannot change lifecycle fields';
  end if;

  if tg_op = 'UPDATE' then
    if new.is_active then
      new.inactive_at := null;
    elsif old.is_active then
      new.inactive_at := pg_catalog.now();
    else
      new.inactive_at := old.inactive_at;
    end if;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function private.enforce_people_role() from public;
