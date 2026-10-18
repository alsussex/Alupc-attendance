-- Store child-program classification on a service visit, not a visitor profile.
-- NULL preserves compatibility and means the visitor is a regular visitor.
alter table public.service_visitors
  add column if not exists child_program text;

alter table public.service_visitors
  drop constraint if exists service_visitors_child_program_check;

alter table public.service_visitors
  add constraint service_visitors_child_program_check
  check (child_program is null or child_program in ('sunday_school', 'childrens_church'));

comment on column public.service_visitors.child_program is
  'Optional per-service child program classification for this named visitor visit.';
