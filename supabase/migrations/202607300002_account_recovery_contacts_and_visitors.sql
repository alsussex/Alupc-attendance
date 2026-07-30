-- Account/profile usability follow-up:
-- optional member contact details, Admin-only notes, and first-name-only visitors.

alter table public.people
  add column if not exists email text,
  add column if not exists phone text;

alter table public.people
  drop constraint if exists people_email_length_check;
alter table public.people
  add constraint people_email_length_check
  check (
    email is null
    or (
      char_length(trim(email)) between 3 and 254
      and trim(email) ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    )
  );

alter table public.people
  drop constraint if exists people_phone_length_check;
alter table public.people
  add constraint people_phone_length_check
  check (phone is null or char_length(trim(phone)) between 3 and 50);

alter table public.service_visitors
  drop constraint if exists service_visitors_first_name_length_check;
alter table public.service_visitors
  add constraint service_visitors_first_name_length_check
  check (char_length(trim(first_name)) between 1 and 100);

alter table public.service_visitors
  drop constraint if exists service_visitors_last_name_length_check;
alter table public.service_visitors
  add constraint service_visitors_last_name_length_check
  check (char_length(trim(last_name)) between 0 and 100);

create table public.member_private_details (
  id uuid primary key,
  organization_id uuid not null
    references public.organizations(id) on delete restrict,
  member_id uuid not null,
  notes text not null default '',
  version bigint not null default 1,
  last_mutation_id uuid,
  created_by uuid not null references auth.users(id) on delete restrict,
  updated_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint member_private_details_member_fk
    foreign key (organization_id, member_id)
    references public.people(organization_id, id) on delete cascade,
  constraint member_private_details_org_member_unique
    unique (organization_id, member_id),
  constraint member_private_details_notes_length
    check (char_length(notes) <= 4000)
);

create index member_private_details_organization_idx
  on public.member_private_details (organization_id, member_id);
create unique index member_private_details_mutation_receipt_idx
  on public.member_private_details (last_mutation_id)
  where last_mutation_id is not null;

create trigger member_private_details_set_updated_at
before insert or update on public.member_private_details
for each row execute function public.set_updated_at();

create trigger member_private_details_increment_version
before update on public.member_private_details
for each row execute function private.increment_record_version();

alter table public.member_private_details enable row level security;

create policy "Admins read private member details in their organization"
on public.member_private_details for select to authenticated
using (
  organization_id = public.current_organization_id()
  and private.is_admin()
);

create policy "Admins add private member details in their organization"
on public.member_private_details for insert to authenticated
with check (
  id = member_id
  and organization_id = public.current_organization_id()
  and private.is_admin()
  and created_by = auth.uid()
  and updated_by = auth.uid()
);

create policy "Admins update private member details in their organization"
on public.member_private_details for update to authenticated
using (
  organization_id = public.current_organization_id()
  and private.is_admin()
)
with check (
  id = member_id
  and organization_id = public.current_organization_id()
  and private.is_admin()
  and updated_by = auth.uid()
);

grant select, insert, update on table public.member_private_details
  to authenticated;

alter table public.member_private_details replica identity full;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'member_private_details'
  ) then
    alter publication supabase_realtime
      add table public.member_private_details;
  end if;
end
$$;
