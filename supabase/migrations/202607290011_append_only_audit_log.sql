-- Permanent, append-only organization audit history.

create table public.audit_log (
  id uuid primary key,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  entity_type text not null check (
    entity_type in ('service', 'attendance', 'visitor', 'member', 'user', 'settings')
  ),
  entity_id text not null check (char_length(entity_id) between 1 and 220),
  action text not null check (char_length(action) between 2 and 80),
  user_id uuid not null references auth.users(id) on delete restrict,
  user_display_name text not null check (char_length(user_display_name) between 1 and 160),
  role public.profile_role not null,
  occurred_at timestamptz not null,
  device_id text check (device_id is null or char_length(device_id) <= 160),
  details jsonb not null default '{}'::jsonb,
  version integer not null default 1 check (version = 1),
  last_mutation_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint audit_log_details_object check (jsonb_typeof(details) = 'object'),
  constraint audit_log_role_action_check check (
    role = 'admin'
    or (
      (entity_type = 'user' and action = 'invitation_accepted')
      or entity_type in ('attendance', 'visitor')
      or (
        entity_type = 'member'
        and action in ('added', 'edited')
      )
      or (
        entity_type = 'service'
        and action in ('created', 'edited', 'completed')
      )
    )
  )
);

create index audit_log_organization_time_idx
  on public.audit_log (organization_id, occurred_at desc, id desc);
create index audit_log_entity_idx
  on public.audit_log (organization_id, entity_type, entity_id, occurred_at desc);
create index audit_log_user_idx
  on public.audit_log (organization_id, user_id, occurred_at desc);
create index audit_log_action_idx
  on public.audit_log (organization_id, action, occurred_at desc);
create unique index audit_log_mutation_receipt_idx
  on public.audit_log (last_mutation_id)
  where last_mutation_id is not null;

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

create trigger audit_log_enforce_insert
before insert on public.audit_log
for each row execute function private.enforce_audit_log_insert();

create or replace function private.reject_audit_log_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'Audit history is append-only';
end;
$$;

revoke all on function private.reject_audit_log_mutation() from public;

create trigger audit_log_reject_update
before update on public.audit_log
for each row execute function private.reject_audit_log_mutation();

create trigger audit_log_reject_delete
before delete on public.audit_log
for each row execute function private.reject_audit_log_mutation();

alter table public.audit_log enable row level security;

create policy "Admins read audit history in their organization"
on public.audit_log for select to authenticated
using (
  organization_id = public.current_organization_id()
  and private.is_admin()
);

create policy "Organization users append their own audit entries"
on public.audit_log for insert to authenticated
with check (
  organization_id = public.current_organization_id()
  and user_id = auth.uid()
  and role = private.current_profile_role()
);

alter table public.audit_log replica identity full;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'audit_log'
  ) then
    alter publication supabase_realtime add table public.audit_log;
  end if;
end
$$;
