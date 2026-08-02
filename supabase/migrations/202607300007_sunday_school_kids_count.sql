-- Sunday School Kids are an independent aggregate on each organization
-- service. Existing services remain valid and begin with a count of zero.

alter table public.services
  add column if not exists sunday_school_kids_count integer not null default 0;

alter table public.services
  drop constraint if exists services_sunday_school_kids_count_check;

alter table public.services
  add constraint services_sunday_school_kids_count_check
  check (sunday_school_kids_count >= 0 and sunday_school_kids_count <= 10000);

comment on column public.services.sunday_school_kids_count is
  'Count of children attending Sunday School without recorded names.';
