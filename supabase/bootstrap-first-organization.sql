-- Run after creating the first user in Supabase Authentication.
-- Replace all three values before running this file in the Supabase SQL editor.
do $$
declare
  first_user_id uuid := '634ce136-6257-4e7e-834a-6b81703a5240';
  new_organization_id uuid := gen_random_uuid();
begin
  insert into public.organizations (id, name, slug, created_by)
  values (new_organization_id, 'Abundant Life UPC', 'alupc', first_user_id);

  insert into public.profiles (id, organization_id, display_name, role)
  values (first_user_id, new_organization_id, 'Robert Clements', 'admin');
end
$$;
