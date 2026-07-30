-- Intelligent member management: restoration recency and non-destructive merges.
-- Merged source rows remain as tombstones so UUID-based history stays traceable.

alter table public.people
  add column if not exists restored_at timestamptz,
  add column if not exists merged_into_id uuid,
  add column if not exists merged_from_ids uuid[] not null default '{}';

update public.people person
set restored_at = history.restored_at
from (
  select entity_id, max(occurred_at) as restored_at
  from public.audit_log
  where entity_type = 'member'
    and action in ('reactivated', 'restored')
  group by entity_id
) history
where person.id::text = history.entity_id
  and person.restored_at is null;

alter table public.people
  drop constraint if exists people_merged_into_member_fk,
  drop constraint if exists people_not_merged_into_self_check;

alter table public.people
  add constraint people_merged_into_member_fk
    foreign key (organization_id, merged_into_id)
    references public.people(organization_id, id) on delete restrict,
  add constraint people_not_merged_into_self_check
    check (
      (merged_into_id is null or merged_into_id <> id)
      and not (id = any(merged_from_ids))
    );

create index if not exists people_organization_restored_at_idx
  on public.people (organization_id, restored_at desc)
  where restored_at is not null;

create index if not exists people_organization_merged_into_idx
  on public.people (organization_id, merged_into_id)
  where merged_into_id is not null;

create or replace function private.enforce_people_role()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_role public.profile_role;
  lifecycle_changed boolean;
  safe_restoration boolean;
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

  lifecycle_changed :=
    tg_op = 'UPDATE'
    and (
      new.is_active is distinct from old.is_active
      or new.inactive_at is distinct from old.inactive_at
      or new.restored_at is distinct from old.restored_at
      or new.deleted_at is distinct from old.deleted_at
    );

  safe_restoration :=
    tg_op = 'UPDATE'
    and (not old.is_active or old.deleted_at is not null)
    and new.is_active
    and new.inactive_at is null
    and new.deleted_at is null
    and new.merged_into_id is null
    and new.merged_from_ids is not distinct from old.merged_from_ids;

  if actor_role = 'attendance_taker' and tg_op = 'UPDATE' and (
    new.merged_into_id is distinct from old.merged_into_id
    or new.merged_from_ids is distinct from old.merged_from_ids
  ) then
    raise exception 'Only administrators can merge church members';
  end if;

  if actor_role = 'attendance_taker'
    and lifecycle_changed
    and not safe_restoration
  then
    raise exception 'Attendance takers may restore members but cannot deactivate, archive, delete, or merge them';
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
