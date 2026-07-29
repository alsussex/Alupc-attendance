-- Service visitor removals use a synchronized tombstone so every device can
-- observe the removal while any linked permanent person remains untouched.
alter table public.service_visitors
  add column if not exists deleted_at timestamptz;

create index if not exists visitors_active_service_idx
  on public.service_visitors (organization_id, service_id)
  where deleted_at is null;
