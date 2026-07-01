-- Run in Supabase SQL Editor if analytics backfill/finalize shows:
-- "new row violates row-level security policy ... analytics_shift_metrics"
--
-- These policies allow unit members to read metrics and allow unit owner/admin/charge
-- members to insert/update compact analytics and staff metrics for their unit.

alter table public.analytics_shift_metrics enable row level security;
alter table public.staff_shift_metrics enable row level security;

drop policy if exists "analytics_shift_metrics_unit_members_select" on public.analytics_shift_metrics;
drop policy if exists "analytics_shift_metrics_unit_leads_insert" on public.analytics_shift_metrics;
drop policy if exists "analytics_shift_metrics_unit_leads_update" on public.analytics_shift_metrics;

create policy "analytics_shift_metrics_unit_members_select"
on public.analytics_shift_metrics
for select
using (
  exists (
    select 1
    from public.unit_members um
    where um.unit_id = analytics_shift_metrics.unit_id
      and um.user_id = auth.uid()
  )
);

create policy "analytics_shift_metrics_unit_leads_insert"
on public.analytics_shift_metrics
for insert
with check (
  exists (
    select 1
    from public.unit_members um
    where um.unit_id = analytics_shift_metrics.unit_id
      and um.user_id = auth.uid()
      and lower(um.role) in ('owner', 'admin', 'charge')
  )
);

create policy "analytics_shift_metrics_unit_leads_update"
on public.analytics_shift_metrics
for update
using (
  exists (
    select 1
    from public.unit_members um
    where um.unit_id = analytics_shift_metrics.unit_id
      and um.user_id = auth.uid()
      and lower(um.role) in ('owner', 'admin', 'charge')
  )
)
with check (
  exists (
    select 1
    from public.unit_members um
    where um.unit_id = analytics_shift_metrics.unit_id
      and um.user_id = auth.uid()
      and lower(um.role) in ('owner', 'admin', 'charge')
  )
);

drop policy if exists "staff_shift_metrics_unit_members_select" on public.staff_shift_metrics;
drop policy if exists "staff_shift_metrics_unit_leads_insert" on public.staff_shift_metrics;
drop policy if exists "staff_shift_metrics_unit_leads_update" on public.staff_shift_metrics;

create policy "staff_shift_metrics_unit_members_select"
on public.staff_shift_metrics
for select
using (
  exists (
    select 1
    from public.unit_members um
    where um.unit_id = staff_shift_metrics.unit_id
      and um.user_id = auth.uid()
  )
);

create policy "staff_shift_metrics_unit_leads_insert"
on public.staff_shift_metrics
for insert
with check (
  exists (
    select 1
    from public.unit_members um
    where um.unit_id = staff_shift_metrics.unit_id
      and um.user_id = auth.uid()
      and lower(um.role) in ('owner', 'admin', 'charge')
  )
);

create policy "staff_shift_metrics_unit_leads_update"
on public.staff_shift_metrics
for update
using (
  exists (
    select 1
    from public.unit_members um
    where um.unit_id = staff_shift_metrics.unit_id
      and um.user_id = auth.uid()
      and lower(um.role) in ('owner', 'admin', 'charge')
  )
)
with check (
  exists (
    select 1
    from public.unit_members um
    where um.unit_id = staff_shift_metrics.unit_id
      and um.user_id = auth.uid()
      and lower(um.role) in ('owner', 'admin', 'charge')
  )
);
