-- Advanced service management: optional service notes.
-- Existing archive fields, organization RLS, versioning, and audit triggers remain unchanged.

alter table public.services
  add column if not exists notes text;

alter table public.services
  drop constraint if exists services_notes_length_check;

alter table public.services
  add constraint services_notes_length_check
  check (notes is null or char_length(notes) <= 4000);
