-- Supabase Table Editor and SQL Editor operations may execute without an Auth
-- JWT. Those privileged database sessions must not be mistaken for an
-- authenticated application user with a missing profile.
--
-- Application roles remain protected: authenticated requests must have an
-- active profile, anonymous requests receive no trigger bypass, and RLS stays
-- enabled and unchanged.

create schema if not exists private;
revoke all on schema private from public;

create or replace function private.is_privileged_database_context()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    auth.role() = 'service_role'
    or (
      auth.uid() is null
      and auth.role() is distinct from 'authenticated'
      and auth.role() is distinct from 'anon'
    )
$$;

revoke all on function private.is_privileged_database_context() from public;

create or replace function private.enforce_people_role()
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
    ) then
      raise exception 'Attendance takers cannot archive or remove services';
    end if;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function private.enforce_people_role() from public;
revoke all on function private.enforce_service_role() from public;
