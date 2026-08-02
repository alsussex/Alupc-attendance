-- Personal appearance preferences synchronize through the existing profiles
-- pull/realtime channel. Application users may change only their own theme;
-- organization membership, role, account status, and identity remain protected.

alter table public.profiles
  add column if not exists theme_preference text not null default 'system',
  add column if not exists version bigint not null default 1,
  add column if not exists last_mutation_id uuid;

alter table public.profiles
  drop constraint if exists profiles_theme_preference_check;

alter table public.profiles
  add constraint profiles_theme_preference_check
  check (theme_preference in ('light', 'dark', 'system'));

create index if not exists profiles_last_mutation_idx
  on public.profiles (last_mutation_id)
  where last_mutation_id is not null;

drop trigger if exists profiles_increment_version on public.profiles;
create trigger profiles_increment_version
before update on public.profiles
for each row execute function private.increment_record_version();

create or replace function private.enforce_profile_self_theme()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Supabase Dashboard/SQL administration and trusted server operations have
  -- no authenticated application UID and remain available to project owners.
  if auth.uid() is null then
    return new;
  end if;

  if auth.uid() <> old.id
    or new.id is distinct from old.id
    or new.organization_id is distinct from old.organization_id
    or new.display_name is distinct from old.display_name
    or new.role is distinct from old.role
    or new.is_active is distinct from old.is_active
    or new.created_at is distinct from old.created_at
  then
    raise exception 'Only your appearance preference may be changed here';
  end if;

  return new;
end;
$$;

revoke all on function private.enforce_profile_self_theme() from public;

drop trigger if exists profiles_enforce_self_theme on public.profiles;
create trigger profiles_enforce_self_theme
before update on public.profiles
for each row execute function private.enforce_profile_self_theme();

drop policy if exists "Users update their own theme preference"
  on public.profiles;
create policy "Users update their own theme preference"
on public.profiles for update to authenticated
using (
  id = auth.uid()
  and organization_id = public.current_organization_id()
  and is_active
)
with check (
  id = auth.uid()
  and organization_id = public.current_organization_id()
  and is_active
);

comment on column public.profiles.theme_preference is
  'Personal appearance preference: light, dark, or system.';
