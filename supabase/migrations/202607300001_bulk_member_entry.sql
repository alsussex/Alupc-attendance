-- Bulk member entry: normalized matching, safe exact-name concurrency, and
-- restoration-only lifecycle permission for Attendance Takers.

alter table public.people
  drop constraint if exists people_last_name_check;

alter table public.people
  add constraint people_last_name_check
  check (char_length(trim(last_name)) between 0 and 100),
  add column if not exists normalized_name text,
  add column if not exists duplicate_name_allowed boolean not null default false;

update public.people
set normalized_name = lower(
  regexp_replace(
    trim(first_name || ' ' || last_name),
    '\s+',
    ' ',
    'g'
  )
)
where normalized_name is null;

alter table public.people
  alter column normalized_name set not null,
  add constraint people_normalized_name_length
  check (char_length(normalized_name) between 1 and 205);

create index if not exists people_organization_normalized_name_idx
  on public.people (organization_id, normalized_name)
  where person_type = 'member';

create or replace function private.normalize_and_guard_member_name()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  should_check_duplicate boolean;
begin
  new.first_name := regexp_replace(trim(new.first_name), '\s+', ' ', 'g');
  new.last_name := regexp_replace(trim(new.last_name), '\s+', ' ', 'g');
  new.display_name := trim(new.first_name || ' ' || new.last_name);
  new.normalized_name := lower(
    regexp_replace(new.display_name, '\s+', ' ', 'g')
  );

  should_check_duplicate :=
    new.person_type = 'member'
    and new.is_active
    and new.deleted_at is null
    and not new.duplicate_name_allowed
    and (
      tg_op = 'INSERT'
      or not old.is_active
      or old.deleted_at is not null
      or new.normalized_name is distinct from old.normalized_name
    );

  if should_check_duplicate then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        new.organization_id::text || ':' || new.normalized_name,
        0
      )
    );
    if exists (
      select 1
      from public.people existing
      where existing.organization_id = new.organization_id
        and existing.person_type = 'member'
        and existing.normalized_name = new.normalized_name
        and existing.is_active
        and existing.deleted_at is null
        and existing.id <> new.id
    ) then
      raise exception using
        errcode = '23505',
        message = 'This member already exists in the organization.';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function private.normalize_and_guard_member_name() from public;

drop trigger if exists people_ensure_normalized_name on public.people;
create trigger people_ensure_normalized_name
before insert or update of
  first_name,
  last_name,
  person_type,
  organization_id,
  is_active,
  deleted_at,
  duplicate_name_allowed
on public.people
for each row execute function private.normalize_and_guard_member_name();

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

  lifecycle_changed :=
    tg_op = 'UPDATE'
    and (
      new.is_active is distinct from old.is_active
      or new.inactive_at is distinct from old.inactive_at
      or new.deleted_at is distinct from old.deleted_at
    );

  safe_restoration :=
    tg_op = 'UPDATE'
    and (not old.is_active or old.deleted_at is not null)
    and new.is_active
    and new.inactive_at is null
    and new.deleted_at is null;

  if actor_role = 'attendance_taker'
    and lifecycle_changed
    and not safe_restoration
  then
    raise exception 'Attendance takers may restore members but cannot deactivate, archive, or delete them';
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

do $$
begin
  if to_regclass('public.audit_log') is not null then
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
  end if;
end
$$;
