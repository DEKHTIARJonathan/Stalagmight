# Plan: Easy Win for User Feedback - Fix Question Mark Tooltip

Date: 2026-03-04

## Picked easy win

From user feedback in `TODO.md`:
- "Fix question mark tooltip" (`?` icon clicked but gave no useful explanation).

Likely target in code:
- `src/components/common/SectionMetadataForm.tsx`
- The `?` icon beside **Closure Adj. Weight** currently relies on native `title` tooltip behavior.

User constraints (confirmed):
- Apply to **all `?` help icons**.
- Interaction should be **hover only**.
- Use an **application-themed custom tooltip** instead of native browser tooltip.

## Why this is a good quick win

- Small, local UI scope (single shared form used in key flows).
- High UX impact (removes ambiguity in a critical import/edit setting).
- Low regression risk (read-only explanatory UI).

## Proposed implementation plan

1. Confirm exact target interaction
- Verify that the feedback refers to the `Closure Adj. Weight` `?` icon.
- Confirm whether fix is needed only there or for all `?` help icons.

2. Inventory and normalize all `?` help icons
- Find every `?` help icon and route it through a shared themed tooltip component.
- Keep behavior hover-based (no click-to-toggle UI).
- Keep existing lightweight affordance (`cursor-help` + small help glyph styling).

3. Improve help copy
- Keep short plain-language explanation of how weight affects closure adjustment.
- Include practical guidance (e.g., "higher = this section moves more").
- Ensure text is localized through i18n key(s), not hardcoded.

4. Add tests
- Add e2e coverage for help icon presence and tooltip visibility/content on hover.
- Assert accessibility labels are preserved for assistive technologies.

5. Verify in both consumers
- `EditSectionDialog`
- `DmpSectionConfigDialog`
- Confirm the same improved tooltip behavior appears in both contexts.

6. Update tracking
- Mark the tooltip feedback item as done in `TODO.md` after merge.

## Acceptance criteria

- Hovering each `?` icon shows the themed tooltip text.
- Tooltip styling matches app theme tokens (panel/background/text/border).
- Explanation text is clear and actionable to a first-time user.
- No regressions in section metadata editing/import flows.

## Risks and mitigations

- Risk: introducing custom tooltip state complexity.
  - Mitigation: use a tiny shared `HelpTooltip` component with CSS hover-only behavior.
- Risk: inconsistent behavior with other help icons.
  - Mitigation: consolidate usage behind one reusable `HelpTooltip` component.
