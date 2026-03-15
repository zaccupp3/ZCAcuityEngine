# Assignment Engine V2

## Goal

Keep the current UI and data model, but replace the assignment decision logic with a sidecar engine that produces the best assignment from a clear priority ladder.

This is a side-by-side rebuild, not a destructive rewrite.

## Hard Constraints

These should never be broken if a preventable alternative exists.

- No preventable RN/PCA tag stacking above configured limits.
- No preventable RN expected-discharge stacking above `3`.
- No preventable PCA expected-discharge stacking above half of that PCA assignment.
- Assignment counts must stay within the mathematically valid range for that role.
  - Example: `12 patients / 3 RNs` means every RN must have `4`.
  - Example: `13 patients / 3 RNs` means only `4/4/5` is allowed.
- Pinned patients must remain with their pinned owner.
- Sitter-only room-pair rules must remain intact.

## Soft Priorities

After hard constraints are satisfied, compare candidates in this exact order:

1. Best count balance
2. Best acuity balance
3. Fewest report sources
4. Best room clustering
5. Most continuity back to previous owner

## Design Rules

- One consistent scorer must evaluate complete candidate assignments.
- The engine may use one-way moves or swaps.
- The engine should prefer a clean one-way move over a noisier multi-step search if that move already produces a rule-clean result.
- The engine should be explainable:
  - what hard constraints were active
  - what candidate won
  - which soft-priority tie-breakers decided the result

## V2 Build Strategy

1. Define scenario fixtures from real unit cases.
2. Build a pure engine module that does not depend on DOM rendering.
3. Compare current engine vs v2 on the same fixtures.
4. Swap UI calls to v2 only after fixture coverage is strong enough.

## Initial Scenario Set

- RN imbalance: `5/4/3` where a clean `4/4/4` move exists.
- RN discharge stack: one RN has `4` expected discharges when a clean split exists.
- PCA discharge overflow: one PCA exceeds half-assignment expected discharges while another can absorb one.
- Pinned continuity: a pinned patient must stay put while the rest rebalance around it.
- Report-source tradeoff: two valid solutions exist, but one has fewer handoff sources.
