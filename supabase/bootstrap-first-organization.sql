-- Run after creating the first user in Supabase Authentication.
-- Replace all three values before running this file in the Supabase SQL editor.
do $$
declare
  first_user_id uuid := 'REPLACE_WITH_AUTH_USER_UUID';
  new_organization_id uuid := gen_random_uuid();
begin
  insert into public.organizations (id, name, slug, created_by)
  values (new_organization_id, 'REPLACE WITH CHURCH NAME', 'replace-with-church-slug', first_user_id);

  insert into public.profiles (id, organization_id, display_name, role)
  values (first_user_id, new_organization_id, 'REPLACE WITH USER NAME', 'admin');
end
$$;
