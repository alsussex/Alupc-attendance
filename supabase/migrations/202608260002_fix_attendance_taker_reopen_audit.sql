-- Permit an Attendance Taker with the explicit per-user permission to append
-- the immutable audit entry created when reopening a completed service.
-- The service transition itself remains protected by private.enforce_service_role().

create or replace function private.enforce_audit_log_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor public.profiles%rowtype;
begin
  if auth.uid() is not null then
    select *
      into actor
      from public.profiles
     where id = auth.uid()
       and is_active;
    if not found then
      raise exception 'Active church access is required';
    end if;

    if actor.role = 'attendance_taker'
       and new.entity_type = 'service'
       and new.action = 'reopened'
       and not coalesce(actor.can_reopen_completed_services, false) then
      raise exception using
        errcode = '42501',
        message = 'Attendance takers do not have permission to record a service reopen';
    end if;

    new.organization_id := actor.organization_id;
    new.user_id := actor.id;
    new.user_display_name := coalesce(
      nullif(trim(actor.display_name), ''),
      'Church user'
    );
    new.role := actor.role;
  end if;
  new.version := 1;
  return new;
end;
$$;

revoke all on function private.enforce_audit_log_insert() from public;

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
        and action in ('created', 'edited', 'completed', 'reopened')
      )
    )
  );
