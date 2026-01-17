# fn-25-nog.1 Add export preview component

## Description
TBD

## Acceptance
- [ ] TBD

## Done summary
Added 300x300 ExportPreview component with MapLibre visualization that updates with debounced 300ms delay when export options change, includes light/dark theme toggle, and shows loading state during rendering.
## Evidence
- Commits: 3f37a254ce591647fa88be4e10f5cf4762efd053
- Tests: pnpm tsc --noEmit, pnpm test:ui -- --grep export-preview, cargo test
- PRs: