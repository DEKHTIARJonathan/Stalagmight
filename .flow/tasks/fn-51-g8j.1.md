# fn-51-g8j.1 Define CSS variable tokens and theme definitions in index.css

## Description

Add a comprehensive set of `--cc-*` CSS custom properties to `src/index.css` with two theme blocks: dark (default, matching existing palette) and light (derived from brand_tokens.css per the brand token mapping table in the epic spec). Includes UI chrome tokens, map visualization tokens, canvas preview tokens, the full 30-pattern opacity variant inventory, `accent-on` token, and explicit shadow alpha token.

**Size:** M
**Files:** `src/index.css`

## Approach

- Add `:root, [data-theme="dark"]` and `[data-theme="light"]` blocks after `@tailwind` directives, before existing styles
- Dark theme values must match existing hardcoded values exactly
- Light theme values derived from `docs/branding/tokens/brand_tokens.css` per the mapping table in the epic spec
- Include `color-scheme: dark` / `color-scheme: light` in respective blocks
- Include `--cc-map-ctrl-shadow` as explicit alpha token for MapLibre control box-shadow
- Include ALL 30 opacity variant tokens for both themes (accent-5 through accent-90, background-30/50/80, panel-20/50/90, error-10/20/30/80/90, warning-10/20/30, success-5/10/30)

## Key context

- Brand token mapping in epic spec: `--sm-limestone-50` (#F3E8D8) → `--cc-background` (#f5f0e8), etc.
- All light values must pass WCAG AA (4.5:1 text, 3:1 UI contrast)
- Opacity variants serve multiple Tailwind utility prefixes (bg, text, border, ring) — same CSS variable value works for all

## Acceptance

- [ ] `:root, [data-theme="dark"]` block defines ALL `--cc-*` variables (70+)
- [ ] `[data-theme="light"]` block defines ALL same variables with light theme values
- [ ] Both blocks include `color-scheme` property
- [ ] Dark theme values match existing hardcoded values exactly
- [ ] Light theme values traceable to brand_tokens.css per epic mapping table
- [ ] Light theme values are WCAG AA compliant (4.5:1 text contrast)
- [ ] Map visualization light values are visible on light backgrounds
- [ ] ALL 30 opacity variants defined for both themes (accent-5/10/20/30/50/70/80/90, background-30/50/80, panel-20/50/90, error-10/20/30/80/90, warning-10/20/30, success-5/10/30)
- [ ] `--cc-accent-on` defined (dark: #1a1a2e, light: #ffffff)
- [ ] `--cc-map-ctrl-shadow` defined as explicit alpha token
- [ ] Variables placed after @tailwind directives, before base styles
- [ ] No existing styles broken (this task only adds new CSS, doesn't replace yet)

## Done summary

(To be filled on completion)

## Evidence

(To be filled on completion)
