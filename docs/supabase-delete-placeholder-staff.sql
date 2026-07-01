-- Delete placeholder staff profiles/metrics that were created before filler-name filtering.
-- Run in Supabase SQL Editor.
--
-- Matches names like:
-- Current RN, Current RN 1, Current PCA 2
-- Oncoming RN, Oncoming PCA 3
-- Incoming RN/PCA, NOC RN/PCA, Day RN/PCA, Night RN/PCA, RN Staff, PCA Staff

delete from public.staff_shift_metrics
where lower(trim(coalesce(staff_name, ''))) ~
  '^(current|oncoming|incoming|noc|day|night)\s+(rn|pca)\s*[0-9]*$'
  or lower(trim(coalesce(staff_name, ''))) ~ '^(rn|pca)\s*(staff|[0-9]+)$'
  or lower(trim(coalesce(staff_name, ''))) = 'unknown staff';

delete from public.unit_staff
where lower(trim(coalesce(display_name, ''))) ~
  '^(current|oncoming|incoming|noc|day|night)\s+(rn|pca)\s*[0-9]*$'
  or lower(trim(coalesce(display_name, ''))) ~ '^(rn|pca)\s*(staff|[0-9]+)$'
  or lower(trim(coalesce(display_name, ''))) = 'unknown staff';
