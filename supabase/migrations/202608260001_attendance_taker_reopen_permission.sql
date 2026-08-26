-- Allow an Admin to grant the single additional permission to an individual
-- Attendance Taker. Admins remain authorized automatically.
alter table public.profiles
  add column if not exists can_reopen_completed_services boolean not null default false;

create or replace function private.enforce_service_role()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_role public.profile_role;
  actor_can_reopen boolean;
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
    if tg_op = 'UPDATE' then
      select coalesce(profile.can_reopen_completed_services, false)
        into actor_can_reopen
        from public.profiles profile
       where profile.id = auth.uid()
         and profile.organization_id = old.organization_id
         and profile.is_active;
    end if;

    if tg_op = 'DELETE' then
      raise exception 'Attendance takers cannot delete services';
    end if;
    if tg_op = 'UPDATE' and (
      new.organization_id is distinct from old.organization_id
      or new.is_archived is distinct from old.is_archived
      or new.deleted_at is distinct from old.deleted_at
      or new.created_by is distinct from old.created_by
      or new.created_at is distinct from old.created_at
      or (old.status = 'completed' and new.status = 'draft' and not coalesce(actor_can_reopen, false))
    ) then
      if old.status = 'completed' and new.status = 'draft' and not coalesce(actor_can_reopen, false) then
        raise exception 'Attendance takers do not have permission to reopen completed services';
      end if;
      raise exception 'Attendance takers cannot reopen, archive, or remove services';
    end if;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function private.enforce_service_role() from public;
