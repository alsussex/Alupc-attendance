-- Preserve church records when an Auth account is permanently deleted.
-- Author UUID columns remain immutable historical snapshots, while only the
-- profile continues to cascade with auth.users.

alter table public.people
  drop constraint if exists people_created_by_fkey,
  drop constraint if exists people_updated_by_fkey;

alter table public.services
  drop constraint if exists services_created_by_fkey,
  drop constraint if exists services_updated_by_fkey;

alter table public.service_attendance
  drop constraint if exists service_attendance_created_by_fkey,
  drop constraint if exists service_attendance_updated_by_fkey;

alter table public.service_visitors
  drop constraint if exists service_visitors_created_by_fkey,
  drop constraint if exists service_visitors_updated_by_fkey;

alter table public.organization_settings
  drop constraint if exists organization_settings_created_by_fkey,
  drop constraint if exists organization_settings_updated_by_fkey;

alter table public.member_private_details
  drop constraint if exists member_private_details_created_by_fkey,
  drop constraint if exists member_private_details_updated_by_fkey;

alter table public.audit_log
  drop constraint if exists audit_log_user_id_fkey;

-- The stored audit user ID, display name, and role are permanent snapshots.
comment on column public.audit_log.user_id is
  'Immutable actor UUID snapshot; deliberately retained after Auth account deletion.';
comment on column public.audit_log.user_display_name is
  'Immutable actor display-name snapshot retained for understandable history.';

-- Keep the audit table append-only except inside the narrowly scoped,
-- service-role-only purge function used by the typed destructive Admin flow.
create or replace function private.reject_audit_log_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE'
     and current_setting(
       'church_attendance.audit_purge_organization_id',
       true
     ) = old.organization_id::text
     and current_setting(
       'church_attendance.audit_purge_user_id',
       true
     ) = old.user_id::text then
    return old;
  end if;
  raise exception 'Audit history is append-only';
end;
$$;

revoke all on function private.reject_audit_log_mutation() from public;

create or replace function public.purge_user_audit_history(
  p_organization_id uuid,
  p_user_id uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  removed_count integer;
begin
  if auth.role() <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'Service-role authorization is required';
  end if;

  perform set_config(
    'church_attendance.audit_purge_organization_id',
    p_organization_id::text,
    true
  );
  perform set_config(
    'church_attendance.audit_purge_user_id',
    p_user_id::text,
    true
  );

  delete from public.audit_log
   where organization_id = p_organization_id
     and user_id = p_user_id;
  get diagnostics removed_count = row_count;

  return removed_count;
end;
$$;

revoke all on function public.purge_user_audit_history(uuid, uuid) from public;
revoke all on function public.purge_user_audit_history(uuid, uuid) from anon;
revoke all on function public.purge_user_audit_history(uuid, uuid) from authenticated;
grant execute on function public.purge_user_audit_history(uuid, uuid)
  to service_role;

comment on function public.purge_user_audit_history(uuid, uuid) is
  'Permanently removes only one deleted user actor snapshot history within one organization; callable only by the service role.';
