create extension if not exists pgcrypto;

create type public.person_type as enum ('member', 'visitor');
create type public.service_status as enum ('draft', 'completed');
create type public.profile_role as enum ('admin', 'attendance_taker');

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 2 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  display_name text,
  role public.profile_role not null default 'attendance_taker',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.people (
  id uuid primary key,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  first_name text not null check (char_length(trim(first_name)) between 1 and 100),
  last_name text not null check (char_length(trim(last_name)) between 1 and 100),
  display_name text not null check (char_length(trim(display_name)) between 1 and 205),
  person_type public.person_type not null default 'member',
  is_active boolean not null default true,
  created_by uuid not null references auth.users(id) on delete restrict,
  updated_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id)
);

create table public.services (
  id uuid primary key,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  service_date date not null,
  service_type text not null check (
    service_type in (
      'Sunday Morning',
      'Sunday Evening',
      'Wednesday Bible Study',
      'Special Service',
      'Other'
    )
  ),
  custom_name text check (custom_name is null or char_length(trim(custom_name)) between 1 and 160),
  status public.service_status not null default 'draft',
  created_by uuid not null references auth.users(id) on delete restrict,
  updated_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id)
);

create table public.service_attendance (
  id text primary key,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  service_id uuid not null,
  person_id uuid not null,
  present boolean not null default true,
  created_by uuid not null references auth.users(id) on delete restrict,
  updated_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, service_id)
    references public.services(organization_id, id) on delete cascade,
  foreign key (organization_id, person_id)
    references public.people(organization_id, id) on delete restrict,
  unique (organization_id, service_id, person_id)
);

create table public.service_visitors (
  id uuid primary key,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  service_id uuid not null,
  first_name text not null check (char_length(trim(first_name)) between 1 and 100),
  last_name text not null check (char_length(trim(last_name)) between 1 and 100),
  display_name text not null check (char_length(trim(display_name)) between 1 and 205),
  saved_as_member boolean not null default false,
  member_person_id uuid,
  created_by uuid not null references auth.users(id) on delete restrict,
  updated_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, service_id)
    references public.services(organization_id, id) on delete cascade,
  foreign key (organization_id, member_person_id)
    references public.people(organization_id, id) on delete restrict,
  check (
    (saved_as_member and member_person_id is not null)
    or (not saved_as_member and member_person_id is null)
  ),
  unique (organization_id, id)
);

create index profiles_organization_idx on public.profiles (organization_id);
create index people_active_members_name_idx
  on public.people (organization_id, lower(display_name))
  where is_active and person_type = 'member';
create index services_date_idx on public.services (organization_id, service_date desc);
create index attendance_service_idx on public.service_attendance (organization_id, service_id);
create index visitors_service_idx on public.service_visitors (organization_id, service_id);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger organizations_set_updated_at before update on public.organizations
for each row execute function public.set_updated_at();
create trigger profiles_set_updated_at before update on public.profiles
for each row execute function public.set_updated_at();
create trigger people_set_updated_at before update on public.people
for each row execute function public.set_updated_at();
create trigger services_set_updated_at before update on public.services
for each row execute function public.set_updated_at();
create trigger attendance_set_updated_at before update on public.service_attendance
for each row execute function public.set_updated_at();
create trigger visitors_set_updated_at before update on public.service_visitors
for each row execute function public.set_updated_at();

create or replace function public.current_organization_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select organization_id
  from public.profiles
  where id = auth.uid() and is_active = true
$$;

revoke all on function public.current_organization_id() from public;
grant execute on function public.current_organization_id() to authenticated;

alter table public.organizations enable row level security;
alter table public.profiles enable row level security;
alter table public.people enable row level security;
alter table public.services enable row level security;
alter table public.service_attendance enable row level security;
alter table public.service_visitors enable row level security;

create policy "Users read their organization"
on public.organizations for select to authenticated
using (id = public.current_organization_id());

create policy "Users read profiles in their organization"
on public.profiles for select to authenticated
using (organization_id = public.current_organization_id());

create policy "Users read people in their organization"
on public.people for select to authenticated
using (organization_id = public.current_organization_id());
create policy "Users add people in their organization"
on public.people for insert to authenticated
with check (
  organization_id = public.current_organization_id()
  and created_by = auth.uid()
  and updated_by = auth.uid()
);
create policy "Users update people in their organization"
on public.people for update to authenticated
using (organization_id = public.current_organization_id())
with check (organization_id = public.current_organization_id() and updated_by = auth.uid());

create policy "Users read services in their organization"
on public.services for select to authenticated
using (organization_id = public.current_organization_id());
create policy "Users add services in their organization"
on public.services for insert to authenticated
with check (
  organization_id = public.current_organization_id()
  and created_by = auth.uid()
  and updated_by = auth.uid()
);
create policy "Users update services in their organization"
on public.services for update to authenticated
using (organization_id = public.current_organization_id())
with check (organization_id = public.current_organization_id() and updated_by = auth.uid());

create policy "Users read attendance in their organization"
on public.service_attendance for select to authenticated
using (organization_id = public.current_organization_id());
create policy "Users add attendance in their organization"
on public.service_attendance for insert to authenticated
with check (
  organization_id = public.current_organization_id()
  and created_by = auth.uid()
  and updated_by = auth.uid()
);
create policy "Users update attendance in their organization"
on public.service_attendance for update to authenticated
using (organization_id = public.current_organization_id())
with check (organization_id = public.current_organization_id() and updated_by = auth.uid());

create policy "Users read visitors in their organization"
on public.service_visitors for select to authenticated
using (organization_id = public.current_organization_id());
create policy "Users add visitors in their organization"
on public.service_visitors for insert to authenticated
with check (
  organization_id = public.current_organization_id()
  and created_by = auth.uid()
  and updated_by = auth.uid()
);
create policy "Users update visitors in their organization"
on public.service_visitors for update to authenticated
using (organization_id = public.current_organization_id())
with check (organization_id = public.current_organization_id() and updated_by = auth.uid());
