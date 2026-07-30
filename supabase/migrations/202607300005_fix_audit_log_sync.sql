-- Allow every active organization user to append immutable audit history
-- without granting Attendance Takers permission to read or update that history.
-- The function is also an idempotent mutation receipt for offline retries.

create or replace function public.append_audit_log_entry(
  p_entry jsonb,
  p_mutation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor public.profiles%rowtype;
  entry_id uuid;
  existing public.audit_log%rowtype;
  inserted public.audit_log%rowtype;
  entry_details jsonb;
begin
  if auth.uid() is null then
    raise exception using
      errcode = '42501',
      message = 'Authentication is required';
  end if;

  select *
    into actor
    from public.profiles
   where id = auth.uid()
     and is_active;

  if not found then
    raise exception using
      errcode = '42501',
      message = 'Active church access is required';
  end if;

  if p_entry is null or jsonb_typeof(p_entry) <> 'object' then
    raise exception using
      errcode = '22023',
      message = 'Audit entry must be an object';
  end if;

  entry_id := (p_entry ->> 'id')::uuid;
  entry_details := coalesce(p_entry -> 'details', '{}'::jsonb);

  if jsonb_typeof(entry_details) <> 'object' then
    raise exception using
      errcode = '22023',
      message = 'Audit details must be an object';
  end if;

  -- A response may be lost after a successful insert. Match both the stable
  -- audit UUID and mutation receipt so the original queue item can be cleared
  -- without attempting an UPDATE against the append-only table.
  select *
    into existing
    from public.audit_log
   where id = entry_id
      or last_mutation_id = p_mutation_id
   order by case when id = entry_id then 0 else 1 end
   limit 1;

  if found then
    if existing.organization_id <> actor.organization_id
       or existing.user_id <> actor.id then
      raise exception using
        errcode = '42501',
        message = 'Audit mutation belongs to another account';
    end if;

    if existing.entity_type <> p_entry ->> 'entity_type'
       or existing.entity_id <> p_entry ->> 'entity_id'
       or existing.action <> p_entry ->> 'action' then
      raise exception using
        errcode = '23505',
        message = 'Audit mutation identity collision';
    end if;

    return jsonb_build_object(
      'version', existing.version,
      'updated_at', existing.updated_at,
      'last_mutation_id', existing.last_mutation_id
    );
  end if;

  insert into public.audit_log (
    id,
    organization_id,
    entity_type,
    entity_id,
    action,
    user_id,
    user_display_name,
    role,
    occurred_at,
    device_id,
    details,
    last_mutation_id
  )
  values (
    entry_id,
    actor.organization_id,
    p_entry ->> 'entity_type',
    p_entry ->> 'entity_id',
    p_entry ->> 'action',
    actor.id,
    coalesce(nullif(trim(actor.display_name), ''), 'Church user'),
    actor.role,
    (p_entry ->> 'occurred_at')::timestamptz,
    nullif(p_entry ->> 'device_id', ''),
    entry_details,
    p_mutation_id
  )
  returning * into inserted;

  return jsonb_build_object(
    'version', inserted.version,
    'updated_at', inserted.updated_at,
    'last_mutation_id', inserted.last_mutation_id
  );
end;
$$;

revoke all on function public.append_audit_log_entry(jsonb, uuid) from public;
revoke all on function public.append_audit_log_entry(jsonb, uuid) from anon;
grant execute on function public.append_audit_log_entry(jsonb, uuid) to authenticated;

comment on function public.append_audit_log_entry(jsonb, uuid) is
  'Appends one organization-scoped audit entry for the active authenticated user and acknowledges idempotent retries.';
