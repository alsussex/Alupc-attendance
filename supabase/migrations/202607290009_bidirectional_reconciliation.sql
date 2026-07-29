-- Durable optimistic concurrency and idempotent mutation receipts.
-- This migration preserves every existing row and does not change RLS access.

alter table public.organizations
  add column if not exists version bigint not null default 1,
  add column if not exists last_mutation_id uuid;
alter table public.organization_settings
  add column if not exists version bigint not null default 1,
  add column if not exists last_mutation_id uuid;
alter table public.people
  add column if not exists version bigint not null default 1,
  add column if not exists last_mutation_id uuid;
alter table public.services
  add column if not exists version bigint not null default 1,
  add column if not exists last_mutation_id uuid;
alter table public.service_attendance
  add column if not exists version bigint not null default 1,
  add column if not exists last_mutation_id uuid;
alter table public.service_visitors
  add column if not exists version bigint not null default 1,
  add column if not exists last_mutation_id uuid;

create or replace function private.increment_record_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.version := old.version + 1;
  return new;
end;
$$;

revoke all on function private.increment_record_version() from public;

drop trigger if exists organizations_increment_version on public.organizations;
create trigger organizations_increment_version
before update on public.organizations
for each row execute function private.increment_record_version();

drop trigger if exists organization_settings_increment_version
  on public.organization_settings;
create trigger organization_settings_increment_version
before update on public.organization_settings
for each row execute function private.increment_record_version();

drop trigger if exists people_increment_version on public.people;
create trigger people_increment_version
before update on public.people
for each row execute function private.increment_record_version();

drop trigger if exists services_increment_version on public.services;
create trigger services_increment_version
before update on public.services
for each row execute function private.increment_record_version();

drop trigger if exists service_attendance_increment_version
  on public.service_attendance;
create trigger service_attendance_increment_version
before update on public.service_attendance
for each row execute function private.increment_record_version();

drop trigger if exists service_visitors_increment_version
  on public.service_visitors;
create trigger service_visitors_increment_version
before update on public.service_visitors
for each row execute function private.increment_record_version();

create index if not exists organizations_last_mutation_idx
  on public.organizations (last_mutation_id)
  where last_mutation_id is not null;
create index if not exists organization_settings_last_mutation_idx
  on public.organization_settings (last_mutation_id)
  where last_mutation_id is not null;
create index if not exists people_last_mutation_idx
  on public.people (last_mutation_id)
  where last_mutation_id is not null;
create index if not exists services_last_mutation_idx
  on public.services (last_mutation_id)
  where last_mutation_id is not null;
create index if not exists service_attendance_last_mutation_idx
  on public.service_attendance (last_mutation_id)
  where last_mutation_id is not null;
create index if not exists service_visitors_last_mutation_idx
  on public.service_visitors (last_mutation_id)
  where last_mutation_id is not null;

-- Realtime is an acceleration layer. Incremental polling remains the durable
-- fallback if a websocket is unavailable.
alter table public.organizations replica identity full;
alter table public.profiles replica identity full;
alter table public.organization_settings replica identity full;
alter table public.people replica identity full;
alter table public.services replica identity full;
alter table public.service_attendance replica identity full;
alter table public.service_visitors replica identity full;

do $$
declare
  table_name text;
begin
  if exists (
    select 1
    from pg_catalog.pg_publication
    where pubname = 'supabase_realtime'
  ) then
    foreach table_name in array array[
      'organizations',
      'profiles',
      'organization_settings',
      'people',
      'services',
      'service_attendance',
      'service_visitors'
    ]
    loop
      if not exists (
        select 1
        from pg_catalog.pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = table_name
      ) then
        execute pg_catalog.format(
          'alter publication supabase_realtime add table public.%I',
          table_name
        );
      end if;
    end loop;
  end if;
end
$$;
