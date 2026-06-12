# Healthcare Analytics Reporting Roadmap

This document outlines high-value reports that can be built from the platform's current data model, plus recommended future data elements for patient satisfaction, staff satisfaction, and healthcare-acquired injury prevention.

It is written for product planning and operational quality improvement. It is not a clinical protocol, legal policy, or substitute for hospital quality department guidance.

## Executive Summary

The platform already captures a unusually useful operational layer: patient rooms, acuity tags, RN/PCA assignment ownership, staffing rosters, workload scores, admits, discharges, assignment movement, finalized shift snapshots, and audit events. That combination can support reports that most hospital dashboards struggle to produce because staffing, geography, and patient acuity are often stored in separate systems.

The highest-value next reports are:

1. Shift Workload Equity Report
2. High-Risk Patient Coverage Report
3. Admit and Discharge Flow Report
4. Assignment Churn Report
5. Staff Load and Burnout Risk Report
6. PCA Rounding and Care Burden Report
7. Fall and Injury Prevention Risk Report
8. Pressure Injury Prevention Coverage Report
9. Patient Experience Readiness Report
10. Leadership Handoff Quality Report

The most valuable analytics direction is not simply counting patients. The strongest value is connecting patient acuity, assignment fairness, care-team workload, room geography, and safety-sensitive tasks into a practical "what should leadership do this shift?" signal.

## Current Data Assets

The platform currently has four durable analytics inputs:

- `shift_snapshots`: full state at finalized shift change, including patients, assignments, oncoming assignments, leadership, and staff profiles.
- `analytics_shift_metrics`: compact shift-level totals such as census, admits, discharges, acuity tag counts, staff counts, and event counts.
- `staff_shift_metrics`: staff-level worked-shift profile including patient count, workload score, rooms, expected discharges, admits, discharges, acuity changes, assignment changes, and event count.
- `audit_events`: append-only events such as admit placement, discharge, assignment movement, acuity change, and live shift start.

The most important live fields for reporting are:

- Patient room and empty/active status.
- RN acuity tags: `tele`, `drip`, `nih`, `bg`, `tf`, `ciwa`, `emu`, `restraint`, `sitter`, `vpo`, `isolation`, `admit`, `lateDc`.
- PCA tags: `chg`, `foley`, `q2turns`, `strictIo`, `heavy`, `feeder`, plus shared high-care tags.
- RN, PCA, and sitter assignment owners.
- Workload/load score.
- Current and oncoming leadership names.
- PCA Resource role.
- Admit queue events and final placement.
- Discharge history and discharge/reinstate events.
- Shift date, shift type, unit id, staff id, staff role, staff name.

## External Quality Frameworks To Align With

CMS HCAHPS is a national standardized survey for discharged patients' perspectives of care. CMS describes its core domains as including nurse and doctor communication, responsiveness of hospital staff, hospital environment, medicines, discharge information, restfulness, care coordination, symptom information, overall rating, and willingness to recommend. Source: https://www.cms.gov/medicare/quality/initiatives/hospital-quality-initiative/hcahps-patients-perspectives-care-survey

AHRQ SOPS Hospital Survey 2.0 measures staff perception of patient safety culture through composites such as teamwork, staffing and work pace, organizational learning, response to error, leader support for safety, communication openness, event reporting, management support, and handoffs/information exchange. Source: https://www.ahrq.gov/sops/surveys/hospital/index.html

AHRQ pressure injury prevention guidance emphasizes interdisciplinary prevention practices and measurement of both pressure injury rates and key care processes. Source: https://www.ahrq.gov/patient-safety/settings/hospital/resource/pressureulcer/tool/index.html

CDC NHSN is the national healthcare-associated infection tracking system and includes patient safety components, analysis resources, and nurse staffing hours indicators. Source: https://www.cdc.gov/nhsn/index.html

## Report 1: Shift Workload Equity Report

Purpose:

Show whether assignments were balanced across RNs and PCAs in a way that reflects patient count, acuity, care burden, and room geography.

Current data used:

- `staff_shift_metrics.patients_assigned`
- `staff_shift_metrics.workload_score`
- `details.patient_rooms`
- Patient acuity tags from `shift_snapshots.state.patients`
- Current RN/PCA assignment arrays

Core metrics:

- Average RN workload score by shift.
- Average PCA workload score by shift.
- Highest-to-lowest workload spread.
- Count of staff above threshold.
- Count of staff below threshold.
- Patient count spread.
- High-acuity tag spread per staff member.
- Geographic spread by room/pod, when unit map metadata is formalized.

Recommended output:

- "Equity score" for the shift.
- Top 3 highest-load staff.
- Top 3 lowest-load staff.
- Suggested rebalance opportunities.
- Narrative: "RN A had 4 patients but a higher load than RN B with 5 because of NIH/BG/tele concentration."

Why it matters:

Staff dissatisfaction often comes less from having work and more from perceived unfairness. This report gives charge nurses a defensible way to discuss assignment fairness using patient complexity instead of raw ratios alone.

Build priority:

Very high. The platform already has most of the needed data.

## Report 2: High-Risk Patient Coverage Report

Purpose:

Identify whether safety-sensitive patients are assigned to appropriate coverage and whether high-risk tags cluster under one staff member.

Current data used:

- Patient acuity tags.
- Current RN/PCA assignment ownership.
- Staff load scores.
- Sitter/VPO/restraint/CIWA/NIH/EMU/isolation tags.

Core metrics:

- Count of high-risk patients by tag.
- High-risk patients by RN.
- High-risk patients by PCA.
- Patients with overlapping high-risk tags.
- Staff with multiple high-risk patients.
- Patients with no RN or PCA coverage.
- High-risk patients assigned to staff already at high load.

Recommended output:

- High-risk census.
- Coverage exceptions.
- "Stacking" warnings where multiple restraints, sitters, CIWA, NIH, or EMU patients land on the same person.
- Recommended huddle list.

Why it matters:

This report connects patient safety risk to actual assignment coverage. It can support shift huddles, charge nurse situational awareness, and prevention planning.

Build priority:

Very high.

## Report 3: Admit and Discharge Flow Report

Purpose:

Track bed flow pressure, admission placement timing, discharge burden, and downstream effect on assignments.

Current data used:

- `ADMIT_ADDED_TO_QUEUE`
- `PRE_ADMIT_TAGS_UPDATED`
- `ADMIT_PLACED`
- `PATIENT_DISCHARGED`
- `PATIENT_REINSTATED`
- `analytics_shift_metrics.admits`
- `analytics_shift_metrics.discharges`
- Admit queue target room/RN/PCA draft data if persisted into future events

Core metrics:

- Admits per shift.
- Discharges per shift.
- Net flow: admits minus discharges.
- Admit queue count by hour.
- Time from queue entry to placement.
- Time from room/RN/PCA preassignment to placement.
- Admissions by RN/PCA.
- Discharges by RN/PCA.
- Late discharge count.
- Assignment load before and after admits.

Recommended output:

- Shift flow timeline.
- Admission bottleneck list.
- Discharge burden by staff.
- "High-flow shift" flag when admits plus discharges exceed threshold.

Why it matters:

Patient experience and staff experience are both affected by flow. Admissions and discharges create work not captured by a simple census number.

Build priority:

High.

Data improvement:

Add `queued_at`, `preassigned_at`, and `placed_at` timestamps to queue payloads. The current event timestamps can support much of this, but explicit fields will make the report cleaner.

## Report 4: Assignment Churn Report

Purpose:

Measure how often patients are moved between staff during a shift and where the movement burden lands.

Current data used:

- `ASSIGNMENT_MOVED`
- Assignment arrays in snapshots.
- Staff shift metrics details.

Core metrics:

- Total assignment moves per shift.
- Moves by role: RN vs PCA.
- Moves by source staff.
- Moves by destination staff.
- Moves by patient acuity tag.
- Moves occurring after admissions or discharges.
- Staff with repeated assignment changes.

Recommended output:

- Churn score.
- Most moved patients.
- Staff most affected by changes.
- Common reasons, if future reason codes are added.

Why it matters:

Excessive assignment churn can create handoff risk, missed expectations, and frustration. It is a strong leading indicator for communication breakdowns.

Build priority:

High.

Data improvement:

Add optional move reason: rebalance, admission, discharge, acuity change, staff call-off, break coverage, patient preference, geography.

## Report 5: Staff Load and Burnout Risk Report

Purpose:

Identify recurring workload pressure patterns that affect staff satisfaction, retention, and perceived fairness.

Current data used:

- `staff_shift_metrics`
- Staff name/staff id.
- Workload score.
- Patients assigned.
- Expected discharges.
- Admits/discharges attributed.
- Acuity changes.
- Assignment changes.
- Event count.

Core metrics:

- Average workload score by staff over selected interval.
- Percent of worked shifts above workload threshold.
- Repeated high-load shifts.
- High-flow exposure: admits plus discharges.
- High-risk exposure: restraints, sitters, CIWA, NIH, BG, EMU.
- Assignment churn exposure.
- Comparison to peer average by role.

Recommended output:

- Staff profile summary.
- "Sustained high load" flags.
- "High churn exposure" flags.
- Pair with staff preference data in future, not as a punitive score.

Why it matters:

This can help leaders make assignments more sustainable over time. The framing should be supportive and operational, not disciplinary.

Build priority:

High.

Governance note:

Staff-level analytics should be role-restricted. The safest framing is workload support and assignment equity, not individual performance grading.

## Report 6: PCA Rounding and Care Burden Report

Purpose:

Quantify PCA workload beyond raw patient count, especially for care-heavy tasks.

Current data used:

- PCA assignments.
- PCA tags: CHG, Foley, Totals/q2 turns, Strict I/O, Heavy, Feeder.
- Shared risk tags: isolation, sitter, restraint, late discharge, admit.
- PCA Resource name.

Core metrics:

- PCA patient count.
- PCA load score.
- CHG count.
- Foley count.
- Totals/q2 turn count.
- Strict I/O count.
- Feeder count.
- Isolation count.
- PCA Resource coverage presence.
- Patients without PCA coverage.

Recommended output:

- PCA burden ranking.
- PCA task cluster summary.
- Resource PCA use recommendation.
- Rounding-risk list for patients needing frequent checks.

Why it matters:

PCA workload is often invisible in nurse-centric staffing tools. Making it visible can improve teamwork, timeliness, and staff satisfaction.

Build priority:

Very high.

Data improvement:

If QR rounding is implemented, capture scan timestamps by room and staff role. That would enable elapsed-time-since-last-round reports.

## Report 7: Fall and Injury Prevention Risk Report

Purpose:

Identify patients and assignments where falls or safety events may be more likely because of risk tag combinations and workload pressure.

Current data used:

- Sitter.
- VPO.
- Restraint.
- CIWA/COWS.
- NIH.
- EMU.
- Isolation.
- Admit.
- Late discharge.
- Patient assignment owner.
- RN/PCA workload score.
- Assignment churn.

Core metrics:

- Fall-risk proxy patient count.
- Patients with multiple observation/safety tags.
- High-risk patients under high-load staff.
- High-risk patients moved during the shift.
- High-risk patients without PCA/RN coverage.
- High-risk patients in geographically spread assignments.

Recommended output:

- Safety watchlist by room.
- Coverage gaps.
- High-risk clustering warnings.
- Suggested charge nurse rounding targets.

Why it matters:

The current platform does not directly know if a fall occurred unless an event type is added. But it can identify leading indicators: observation burden, cognitive/neurologic risk markers, withdrawal-related monitoring, and assignment strain.

Build priority:

High.

Data improvement:

Add explicit event types for `FALL_EVENT`, `ASSISTED_FALL`, `NEAR_FALL`, and `SAFETY_ROUND_COMPLETED`, with room, patient id, staff role, injury level, and whether sitter/VPO/restraint/bed alarm were active.

## Report 8: Pressure Injury Prevention Coverage Report

Purpose:

Track patients whose care burden suggests skin-risk prevention work may be especially important.

Current data used:

- Totals/q2 turns.
- Strict I/O/heavy.
- Feeder.
- Foley.
- Isolation.
- PCA/RN assignment ownership.
- Workload score.
- PCA Resource.

Core metrics:

- Patients tagged for turning/total care.
- Patients with overlapping mobility/care-burden tags.
- Q2 turn burden by PCA.
- Q2 turn burden by RN.
- High skin-risk proxy patients under high workload.
- Resource PCA coverage presence.

Recommended output:

- Q2/total care watchlist.
- PCA burden view.
- "Skin prevention support needed" shift flag.
- Patients needing care-plan verification, if future documentation fields are added.

Why it matters:

AHRQ pressure injury guidance emphasizes interdisciplinary prevention and measuring care processes, not only final injury rates. This platform can become a process-measure engine for whether the work is visible and distributed.

Build priority:

Medium-high.

Data improvement:

Add a dedicated `skinRisk` or `turnSchedule` field instead of relying only on `q2turns`/`totals`. Add rounding/turn completion events if the platform will track care process reliability.

## Report 9: Patient Experience Readiness Report

Purpose:

Create a shift-level proxy for factors that can influence patient satisfaction and HCAHPS-style experience domains.

Current data used:

- Staffing count.
- Census.
- RN/PCA workload score.
- Assignment gaps.
- Admit/discharge flow.
- Late discharge tags.
- High-risk tags.
- Assignment churn.
- Leadership coverage.
- PCA Resource coverage.

Core metrics:

- Patients per RN and PCA.
- Staff above high workload threshold.
- Patients without complete RN/PCA coverage.
- Discharge burden.
- Admission burden.
- Late discharge burden.
- Assignment churn.
- High-risk patients requiring frequent responsiveness.

Recommended output:

- "Responsiveness risk" score.
- "Discharge communication pressure" score.
- "Care coordination complexity" score.
- Shift leader action list.

Why it matters:

The platform does not collect patient survey answers. But it can produce operational leading indicators related to responsiveness, coordination, communication load, and discharge complexity. These align conceptually with HCAHPS domains without claiming to replace HCAHPS.

Build priority:

Medium-high.

Data improvement:

Add optional lightweight post-discharge or bedside microfeedback only if approved by the organization. Keep it separate from official HCAHPS.

## Report 10: Leadership Handoff Quality Report

Purpose:

Improve shift-to-shift continuity by measuring whether leadership, staffing, assignments, high-risk patients, and unresolved flow items were cleanly passed forward.

Current data used:

- Current and incoming leadership.
- Current and incoming assignments.
- Shift snapshots.
- High-risk tags.
- Admit queue.
- Discharge history.
- Staffing rosters.
- Patients without full coverage.

Core metrics:

- Leadership completeness: charge, mentor/resource, CTA, PCA resource.
- Current assignment completeness.
- Oncoming assignment completeness.
- High-risk patients carried into oncoming.
- Open admit queue count at handoff.
- Late discharge count at handoff.
- Staff roster changes between current and oncoming.

Recommended output:

- Handoff readiness score.
- Missing leadership roles.
- Uncovered patients.
- Open admits.
- High-risk carryover.
- Call-off/staffing variance.

Why it matters:

Handoffs are a major safety-culture and patient-safety domain. AHRQ SOPS includes handoffs and information exchange as a survey composite, and the platform is already structured around live-to-oncoming transition.

Build priority:

Very high.

## Recommended Analytics Dashboard Structure

### Executive Unit View

Audience:

Charge nurses, managers, clinical mentors, quality partners.

Widgets:

- Current census and staffed capacity.
- RN/PCA workload spread.
- High-risk patient count.
- Open admits and expected discharges.
- Coverage gaps.
- Shift flow: admits, discharges, assignment moves.
- Handoff readiness.

### Staff Support View

Audience:

Managers, charge nurses, staffing leaders.

Widgets:

- Workload trend by staff.
- High-load streaks.
- Staff exposure to high-risk patients.
- Admission/discharge burden.
- Assignment churn burden.
- Peer comparison by role.

### Safety Prevention View

Audience:

Charge nurses, quality/safety, clinical mentors.

Widgets:

- Fall-risk proxy watchlist.
- Pressure injury prevention watchlist.
- Sitter/VPO/restraint clustering.
- Isolation and high-observation burden.
- Q2/total care burden.
- High-risk patients with staffing gaps.

### Flow and Experience View

Audience:

Charge nurses, throughput teams, managers.

Widgets:

- Admit queue trend.
- Placement time.
- Discharge burden.
- Late discharge trend.
- Responsiveness risk.
- Discharge communication pressure.
- Staffing strain during high-flow periods.

## Suggested Composite Scores

Composite scores should be transparent and explainable. Avoid black-box scoring for clinical operations.

### Shift Strain Index

Inputs:

- Census.
- Average RN load.
- Average PCA load.
- Number of staff above threshold.
- High-risk patient count.
- Admits plus discharges.
- Assignment moves.

Use:

Quickly identify shifts that were operationally difficult.

### Assignment Equity Index

Inputs:

- Workload spread.
- Patient count spread.
- High-acuity tag spread.
- Room spread.
- Admission/discharge burden spread.

Use:

Support fair assignments and explain why equal patient counts are not always equal work.

### Responsiveness Risk Index

Inputs:

- PCA workload.
- RN workload.
- Patients without complete coverage.
- Sitter/restraint/CIWA/high-observation count.
- Admit/discharge activity.
- Assignment churn.

Use:

Predict when patients may experience delays in call-light response, communication, or routine needs.

### Injury Prevention Attention Index

Inputs:

- Sitter/VPO/restraint/CIWA/NIH/EMU.
- Totals/q2 turns.
- Foley/strict I/O/heavy/feeder.
- Workload score.
- Coverage gaps.
- Recent assignment moves.

Use:

Identify rooms that should be highlighted for charge/resource rounding.

### Handoff Readiness Index

Inputs:

- Leadership completeness.
- Oncoming assignment completeness.
- High-risk carryover count.
- Admit queue count.
- Late discharge count.
- Coverage gaps.

Use:

Make shift change safer and more standardized.

## Data Elements To Add Next

Highest-impact additions:

- Admit queue timestamps: queued, drafted/preassigned, placed.
- Optional reason codes for assignment moves.
- Explicit fall/near-fall/safety event logging.
- Explicit pressure injury or skin-risk flag, separate from q2/total care proxy.
- Rounding event capture by room, role, and timestamp.
- Break/meal relief coverage field.
- Staff call-off/reassignment reason when removed from roster.
- Patient geography metadata: pod, hallway, distance group.
- Handoff checklist completion.
- Optional staff pulse check: workload felt fair, support adequate, safety concerns.

Do not add everything at once. The best next sequence is:

1. Reason codes for assignment moves.
2. Queue timing fields.
3. Rounding event timestamps.
4. Safety event types.
5. Handoff checklist fields.
6. Staff pulse fields.

## Report Governance

Recommended principles:

- Use staff reports to support staffing, coaching, and fairness, not punishment.
- Label proxy measures clearly. For example, "fall-risk proxy" is not the same as an actual fall rate.
- Keep official quality measures separate from internal operational indicators.
- Let users drill into the underlying rooms/tags/events behind every score.
- Preserve audit events as append-only records.
- Restrict staff-level longitudinal reports to appropriate leadership roles.
- Avoid displaying sensitive patient identifiers beyond room/bed context unless the organization explicitly approves it.

## Practical Build Order

### Phase 1: High-Value Reports From Current Data

- Workload Equity Report.
- High-Risk Patient Coverage Report.
- Handoff Readiness Report.
- PCA Care Burden Report.
- Admit/Discharge Flow Report.

### Phase 2: Add Better Event Detail

- Assignment move reason.
- Queue timing.
- Rounding QR timestamp integration.
- Safety event logging.
- Staff call-off/removal reason.

### Phase 3: Predictive and Comparative Analytics

- Shift Strain Index.
- Responsiveness Risk Index.
- Injury Prevention Attention Index.
- Staff high-load streaks.
- Unit trend lines by day/night shift.
- Pre/post intervention analysis.

### Phase 4: Quality Partnership Reporting

- Monthly unit safety packet.
- Patient experience operations packet.
- Staffing equity and retention packet.
- Injury prevention process-measure packet.
- Handoff reliability packet.

## Example Monthly Reports

### Monthly Unit Flow and Safety Packet

Sections:

- Census trend by shift.
- Admit/discharge volume.
- Late discharge burden.
- High-risk tag trends.
- Assignment churn.
- Shift strain distribution.
- Top operational recommendations.

### Monthly Staffing Equity Packet

Sections:

- Workload spread by shift.
- Staff high-load exposure.
- PCA care-burden distribution.
- RN high-risk exposure.
- Assignment churn exposure.
- Staffing roster variance.

### Monthly Injury Prevention Packet

Sections:

- Fall-risk proxy patient volume.
- Observation burden: sitter, VPO, restraint.
- Skin-risk proxy volume: q2/total care, strict I/O, heavy care.
- High-risk patients under high workload.
- Rounding process reliability, once QR rounding is implemented.
- Safety event trend, once event logging is added.

### Monthly Patient Experience Operations Packet

Sections:

- Responsiveness risk by shift.
- Discharge communication pressure.
- Admit placement delay.
- Assignment stability.
- Staffing strain.
- HCAHPS-adjacent operational opportunities.

## Bottom Line

The strongest analytics opportunity is to convert the charge nurse's real-time mental model into reliable operational data: who is assigned where, who is overloaded, which patients are high risk, what changed during the shift, and what needs to be handed off.

The platform should avoid pretending to replace official hospital quality systems. Its value is earlier and more practical: it can reveal shift-level conditions that lead to safety events, delayed responsiveness, poor staff experience, and weaker handoff reliability before those problems show up in lagging outcome reports.
