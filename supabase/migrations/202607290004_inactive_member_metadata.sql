-- Preserve when a member was made inactive and keep lifecycle changes
-- administrator-only. Existing rows may remain null because older clients did
-- not record this timestamp.

alter table public.people
add column if not exists inactive_at timestamptz;

create index if not exists people_inactive_name_idx
on public.people (organization_id, display_name)
where not is_active and deleted_at is null;

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
      or new.inactive_at is distinct from old.inactive_at
      or new.deleted_at is distinct from old.deleted_at
      or new.created_by is distinct from old.created_by
      or new.created_at is distinct from old.created_at
    ) then
      raise exception 'Attendance takers may edit member names but cannot archive or reactivate members';
    end if;
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
