-- Stage 1.5: make updated_at a server-managed synchronization cursor on inserts
-- as well as updates. This prevents an offline client from choosing an arbitrary
-- cloud version timestamp when its queued record is first uploaded.

drop trigger if exists organizations_set_updated_at on public.organizations;
create trigger organizations_set_updated_at
before insert or update on public.organizations
for each row execute function public.set_updated_at();

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
before insert or update on public.profiles
for each row execute function public.set_updated_at();

drop trigger if exists people_set_updated_at on public.people;
create trigger people_set_updated_at
before insert or update on public.people
for each row execute function public.set_updated_at();

drop trigger if exists services_set_updated_at on public.services;
create trigger services_set_updated_at
before insert or update on public.services
for each row execute function public.set_updated_at();

drop trigger if exists attendance_set_updated_at on public.service_attendance;
create trigger attendance_set_updated_at
before insert or update on public.service_attendance
for each row execute function public.set_updated_at();

drop trigger if exists visitors_set_updated_at on public.service_visitors;
create trigger visitors_set_updated_at
before insert or update on public.service_visitors
for each row execute function public.set_updated_at();
