-- Fallback when email delivery is not configured:
-- 1. Create and confirm the new authentication user in Supabase Auth.
-- 2. Replace only the two UUID placeholders below.
-- 3. Run this block once. It derives the existing organization from the
--    current administrator and never creates another organization.

do $$
declare
  existing_admin_id uuid := 'REPLACE_WITH_EXISTING_ADMIN_AUTH_UUID';
  new_user_id uuid := 'REPLACE_WITH_NEW_AUTH_USER_UUID';
  existing_organization_id uuid;
begin
  select organization_id
  into existing_organization_id
  from public.profiles
  where id = existing_admin_id
    and role = 'admin'
    and is_active = true;

  if existing_organization_id is null then
    raise exception 'The supplied existing administrator was not found';
  end if;

  insert into public.profiles (
    id,
    organization_id,
    display_name,
    role,
    is_active
  )
  values (
    new_user_id,
    existing_organization_id,
    'REPLACE WITH USER DISPLAY NAME',
    'attendance_taker',
    true
  )
  on conflict (id) do update
  set
    organization_id = excluded.organization_id,
    display_name = excluded.display_name,
    role = 'attendance_taker',
    is_active = true;
end
$$;
