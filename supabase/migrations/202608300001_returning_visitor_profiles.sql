-- Persistent returning-visitor identities.
--
-- A person row with person_type = 'visitor' is the stable identity. Individual
-- service_visitors rows remain the immutable per-service visit records and link
-- to that identity. Existing visit rows are intentionally not merged by name;
-- the application links them only after a user confirms the returning visitor.

alter table public.service_visitors
  add column if not exists visitor_person_id uuid;

alter table public.service_visitors
  drop constraint if exists service_visitors_visitor_person_fk;
alter table public.service_visitors
  add constraint service_visitors_visitor_person_fk
  foreign key (organization_id, visitor_person_id)
  references public.people(organization_id, id)
  on delete restrict;

create index if not exists service_visitors_visitor_person_idx
  on public.service_visitors (organization_id, visitor_person_id, service_id)
  where visitor_person_id is not null;

create index if not exists people_active_visitors_name_idx
  on public.people (organization_id, normalized_name)
  where person_type = 'visitor'
    and is_active
    and deleted_at is null
    and merged_into_id is null;

create or replace function private.enforce_service_visitor_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.visitor_person_id is not null and not exists (
    select 1
      from public.people person
     where person.organization_id = new.organization_id
       and person.id = new.visitor_person_id
       and person.person_type = 'visitor'
       and person.is_active
       and person.deleted_at is null
       and person.merged_into_id is null
  ) then
    raise exception using
      errcode = '23503',
      message = 'Returning visitor identity is invalid or belongs to another organization';
  end if;
  return new;
end;
$$;

revoke all on function private.enforce_service_visitor_identity() from public;

drop trigger if exists service_visitors_enforce_identity
  on public.service_visitors;
create trigger service_visitors_enforce_identity
before insert or update of visitor_person_id, organization_id
on public.service_visitors
for each row execute function private.enforce_service_visitor_identity();

-- Both existing application roles already create named service visitors. Allow
-- them to create and update the corresponding active visitor identity while
-- retaining the existing member lifecycle and organization protections.
drop policy if exists "Admins add or upsert members in their organization"
  on public.people;
drop policy if exists "Admins add or upsert people in their organization"
  on public.people;
create policy "Admins add or upsert people in their organization"
on public.people for insert to authenticated
with check (
  organization_id = public.current_organization_id()
  and private.is_admin()
  and person_type in ('member', 'visitor')
  and updated_by = auth.uid()
  and (
    private.people_record_exists_in_organization(id, organization_id)
    or (
      created_by = auth.uid()
      and is_active
      and inactive_at is null
      and deleted_at is null
    )
  )
  and (deleted_at is null or not is_active)
  and (not is_active or inactive_at is null)
);

drop policy if exists "Attendance takers add or upsert active members"
  on public.people;
drop policy if exists "Attendance takers add or upsert active people"
  on public.people;
create policy "Attendance takers add or upsert active people"
on public.people for insert to authenticated
with check (
  organization_id = public.current_organization_id()
  and private.current_profile_role() = 'attendance_taker'
  and person_type in ('member', 'visitor')
  and is_active
  and inactive_at is null
  and deleted_at is null
  and updated_by = auth.uid()
  and (
    created_by = auth.uid()
    or private.people_record_exists_in_organization(id, organization_id)
  )
);

drop policy if exists "Admins update people in their organization"
  on public.people;
create policy "Admins update people in their organization"
on public.people for update to authenticated
using (
  organization_id = public.current_organization_id()
  and private.is_admin()
)
with check (
  organization_id = public.current_organization_id()
  and private.is_admin()
  and person_type in ('member', 'visitor')
  and updated_by = auth.uid()
  and (deleted_at is null or not is_active)
  and (not is_active or inactive_at is null)
);

drop policy if exists "Attendance takers update ordinary member fields"
  on public.people;
drop policy if exists "Attendance takers update ordinary people fields"
  on public.people;
create policy "Attendance takers update ordinary people fields"
on public.people for update to authenticated
using (
  organization_id = public.current_organization_id()
  and private.current_profile_role() = 'attendance_taker'
)
with check (
  organization_id = public.current_organization_id()
  and private.current_profile_role() = 'attendance_taker'
  and person_type in ('member', 'visitor')
  and updated_by = auth.uid()
);

comment on column public.service_visitors.visitor_person_id is
  'Stable organization-scoped visitor identity used to link repeat visits without merging people by name.';
