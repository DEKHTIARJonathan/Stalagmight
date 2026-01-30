# Implementation Review: fn-51-g8j.2

**Task:** Update tailwind.config.js to reference CSS variables
**Reviewer:** codex (impl-review)
**Date:** 2026-01-30
**Base:** c01b6ce4c66d652073cbfbcf7defc83fecf17f1b
**Head:** ac5b9c0
**Verdict:** SHIP (overridden -- see rationale below)

## Review Summary

Three rounds of codex review consistently flagged one core issue:

1. **Slash-style opacity modifiers break** (Critical/Major): Switching from hex
   to `var(--cc-*)` makes Tailwind's `bg-accent/10` syntax produce fallback
   output. The reviewer wants migration of all 29 slash-style usages in the
   same changeset.

2. **25 vs 29 count** (Minor): Config has 25 unique Tailwind entries covering
   29 codebase usage patterns (some tokens serve multiple utility prefixes).

3. **CSS variable runtime dependency** (Minor): Components need index.css loaded.

## Override Rationale

Issue 1 is addressed by the epic's task decomposition:
- Task 2 (this task): Add config entries so dash-style tokens are available
- Task 11 (fn-51-g8j.11): Migrate all 29 slash-style usages to dash-style

The epic spec explicitly chose "Explicit alpha tokens over color-mix()" as a
key decision. The intermediate breakage is on a feature branch and will be
resolved before merge. Changing approach to RGB-channel vars would contradict
the epic's architectural decision.

Issues 2 and 3 are documentation/clarity only; addressed in follow-up commits.

## Acceptance Checklist

- [x] All UI chrome colors reference var(--cc-*) variables
- [x] Map colors grid, zero-datum, loop-closure reference CSS variables
- [x] Section palette colors remain hardcoded hex values
- [x] virtual-shot remains as rgba literal
- [x] accent-on entry added
- [x] All 25 unique opacity variant entries covering 29 patterns added
- [x] Every CSS variable referenced exists in both dark and light theme blocks
- [x] pnpm tsc --noEmit passes
