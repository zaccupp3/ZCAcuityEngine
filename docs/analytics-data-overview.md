# Analytics Data Overview

This document summarizes what the Analytics tab currently reads, what the app collects during live use, and how Supabase events are paired with finalized shift metrics.

## Current Analytics Inputs

The Analytics tab loads four Supabase tables for the active unit:

- `analytics_shift_metrics`: one compact row per finalized shift. This powers unit-level shift trends such as total patients, admits, discharges, tag counts, staff counts, and event counts.
- `shift_snapshots`: one full state snapshot per finalized shift. This preserves the full patient list, current assignment, oncoming assignment, leadership team, and staff profiles at finalize time.
- `staff_shift_metrics`: one row per RN/PCA who worked a finalized shift. This powers staff profiles, workload trends, patient counts, and staff-level event attribution.
- `audit_events`: append-only operational events created during live work. These are used to count flow and attribution events such as admits, discharges, acuity changes, and assignment moves.

## Event Collection

The app records events through `window.appendEvent(type, payload, meta)`. Each event includes:

- `id`: UUID for idempotent Supabase inserts.
- `ts`: event timestamp.
- `type`: event name.
- `unitId`: active unit id.
- `shiftKey`: current live shift key.
- `actor`: currently usually `local` unless caller passes an actor.
- `payload`: event-specific JSON.
- `meta`: optional source/version context.

When Supabase is ready, events are inserted into `public.audit_events`. If Supabase is unavailable, events are queued in a per-unit local outbox and flushed later.

Currently important event types include:

- `SHIFT_LIVE_STARTED`: starts a live shift event context.
- `ADMIT_ADDED_TO_QUEUE`, `ADMIT_REMOVED_FROM_QUEUE`, `PRE_ADMIT_TAGS_UPDATED`, `ADMIT_PLACED`: admit queue lifecycle and final placement.
- `PATIENT_DISCHARGED`, `PATIENT_REINSTATED`, `DISCHARGE_SESSION_RESET`: discharge workflow.
- `ASSIGNMENT_MOVED`: patient movement between RN/PCA assignment owners.
- `ACUITY_CHANGED`: patient tag changes with RN/PCA attribution when available.

## Finalize Shift Output

When a shift is finalized, the app writes current live data before promoting oncoming to live.

`shift_snapshots.state` stores:

- `total_pts`, `admits`, `discharges`, `acuity_changes`, `assignment_changes`.
- `live_shift_key`.
- Full `patients` array.
- `current_assignment`: current RNs, PCAs, sitters.
- `oncoming_assignment`: oncoming RNs, PCAs, sitters.
- `leadership`: current and incoming charge, resource/mentor, CTA, and PCA resource.
- `staff_profiles`: per RN/PCA role, name, staff id, local owner id, patient ids, rooms, workload score, expected discharges, admits, discharges, acuity changes, assignment changes, and event count.

`analytics_shift_metrics` stores:

- `unit_id`, `shift_date`, `shift_type`.
- `total_pts`.
- `admits`.
- `discharges`.
- `tag_counts` for `tele`, `drip`, `nih`, `bg`, `ciwa`, `emu`, `restraint`, `sitter`, `vpo`, `isolation`, `admit`, and `lateDc`.
- `metrics.version`, `metrics.live_shift_key`, `metrics.totals`, `metrics.tag_counts`, and `metrics.staff_counts`.

`staff_shift_metrics` stores:

- `unit_id`, `shift_date`, `shift_type`.
- `staff_id`, `staff_name`, `role`.
- `patients_assigned`.
- `workload_score`.
- `details.patient_ids`, `details.patient_rooms`, `details.expected_discharges`, `details.admits`, `details.discharges`, `details.acuity_changes`, `details.assignment_changes`, `details.event_count`, `details.live_shift_key`, and `details.local_owner_id`.

## How Analytics Uses The Data

Unit view combines `analytics_shift_metrics` with `shift_snapshots`. If a compact analytics row is missing tag counts or totals, the snapshot is used as a fallback.

Staff view uses `staff_shift_metrics`, then cross-references snapshots to describe the actual patients and tags assigned to a staff member during worked shifts. Staff aliases, dismissals, and hidden profiles are stored locally per unit to keep profile cleanup lightweight.

Backfill rebuilds `analytics_shift_metrics` and `staff_shift_metrics` from durable `shift_snapshots` plus `audit_events`. It first matches audit events by `live_shift_key`; if that is unavailable, it falls back to the shift date/time window.

## Current Limits And Buildout Notes

- Analytics history is strongest after shifts are finalized. Live in-progress state is visible elsewhere in the app but is not the same as a finalized analytics row.
- Event attribution depends on payload quality. Admits, discharges, assignment moves, and acuity changes need RN/PCA identifiers or names to attach cleanly to staff profiles.
- Staff profile cleanup is partly local right now through aliases, dismissals, and hidden staff lists.
- `audit_events` are append-only and useful for deeper future analytics: time-to-place admits, assignment churn, discharge pacing, high-risk tag transitions, and workload volatility.
- `shift_snapshots` are the safest source for reprocessing because they preserve the full patient and assignment state at finalize time.
