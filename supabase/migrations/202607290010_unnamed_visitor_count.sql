-- Unnamed visitors are an aggregate on the organization service. This avoids
-- fake visitor rows while preserving local-first versioned synchronization.

alter table public.services
  add column if not exists unnamed_visitor_count integer not null default 0;

alter table public.services
  drop constraint if exists services_unnamed_visitor_count_check;

alter table public.services
  add constraint services_unnamed_visitor_count_check
  check (unnamed_visitor_count >= 0 and unnamed_visitor_count <= 10000);

comment on column public.services.unnamed_visitor_count is
  'Count of present visitors whose names were not recorded for this service.';
