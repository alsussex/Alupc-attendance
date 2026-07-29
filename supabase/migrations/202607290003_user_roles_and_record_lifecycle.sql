-- Stage 2: enforce administrator-only lifecycle operations while preserving
-- local-first soft removal and the existing organization boundary.

alter table public.people
add column if not exists deleted_at timestamptz;

alter table public.services
add column if not exists is_archived boolean not null default false,
add column if not exists deleted_at timestamptz;

create index if not exists profiles_active_role_idx
on public.profiles (organization_id, role)
where is_active;

create index if not exists services_active_date_idx
on public.services (organization_id, service_date desc)
where deleted_at is null and not is_archived;

create schema if not exists private;
revoke all on schema private from public;

create or replace function private.current_profile_role()
returns public.profile_role
language sql
stable
security definer
set search_path = ''
as $$
  select role
  from public.profiles
  where id = auth.uid() and is_active = true
$$;

create or replace function private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(private.current_profile_role() = 'admin', false)
$$;

revoke all on function private.current_profile_role() from public;
revoke all on function private.is_admin() from public;
grant usage on schema private to authenticated;
grant execute on function private.current_profile_role() to authenticated;
grant execute on function private.is_admin() to authenticated;

drop policy if exists "Users add people in their organization" on public.people;
create policy "Users add members in their organization"
on public.people for insert to authenticated
with check (
  organization_id = public.current_organization_id()
  and person_type = 'member'
  and is_active = true
  and deleted_at is null
  and created_by = auth.uid()
  and updated_by = auth.uid()
);

create policy "Admins update their organization"
on public.organizations for update to authenticated
using (id = public.current_organization_id() and private.is_admin())
with check (id = public.current_organization_id() and private.is_admin());

create policy "Admins delete people in their organization"
on public.people for delete to authenticated
using (
  organization_id = public.current_organization_id()
  and private.is_admin()
);

create policy "Admins delete services in their organization"
on public.services for delete to authenticated
using (
  organization_id = public.current_organization_id()
  and private.is_admin()
);

grant delete on table public.people to authenticated;
grant delete on table public.services to authenticated;

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

  if actor_role = 'attendance_taker' then
    if tg_op = 'DELETE' then
      raise exception 'Attendance takers cannot delete church members';
    end if;
    if tg_op = 'UPDATE' and (
      new.organization_id is distinct from old.organization_id
      or new.person_type is distinct from old.person_type
      or new.is_active is distinct from old.is_active
      or new.deleted_at is distinct from old.deleted_at
      or new.created_by is distinct from old.created_by
      or new.created_at is distinct from old.created_at
    ) then
      raise exception 'Attendance takers may edit member names but cannot archive or remove members';
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
  if auth.role() = 'service_role' then
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

create or replace function private.protect_last_admin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  removes_active_admin boolean;
  remaining_admins integer;
begin
  removes_active_admin :=
    old.role = 'admin'
    and old.is_active
    and (
      tg_op = 'DELETE'
      or new.role <> 'admin'
      or not new.is_active
      or new.organization_id <> old.organization_id
    );

  if not removes_active_admin then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(old.organization_id::text, 0)
  );

  select count(*)
  into remaining_admins
  from public.profiles
  where organization_id = old.organization_id
    and role = 'admin'
    and is_active
    and id <> old.id;

  if remaining_admins = 0 then
    raise exception 'The church must keep at least one active administrator';
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function private.enforce_people_role() from public;
revoke all on function private.enforce_service_role() from public;
revoke all on function private.protect_last_admin() from public;

drop trigger if exists people_enforce_role on public.people;
create trigger people_enforce_role
before update or delete on public.people
for each row execute function private.enforce_people_role();

drop trigger if exists services_enforce_role on public.services;
create trigger services_enforce_role
before update or delete on public.services
for each row execute function private.enforce_service_role();

drop trigger if exists profiles_protect_last_admin on public.profiles;
create trigger profiles_protect_last_admin
before update or delete on public.profiles
for each row execute function private.protect_last_admin();
