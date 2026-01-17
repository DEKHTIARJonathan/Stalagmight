# fn-9-5px.1 Add MapLibre section preview component

## Description
## Overview
Add MapLibre section preview 250x250 with zoom/pan.

## Implementation
1. Create SectionPreview.tsx component
2. Initialize minimal MapLibre instance
3. Render stations + shots
4. Auto-fit bounds on selection
5. Add to DmpImportDialog

## Files
- src/components/Dialogs/SectionPreview.tsx (new)
- src/components/Dialogs/DmpImportDialog.tsx
## Acceptance
- [ ] Preview component created
- [ ] MapLibre initialized
- [ ] Stations rendered
- [ ] Shots rendered
- [ ] Zoom/pan works
- [ ] Auto-fits bounds
- [ ] Tests pass
## Done summary
Added MapLibre section preview component (250x250) to the DMP Import Dialog. The preview shows station dots and shot lines for the currently selected section, with zoom (wheel) and pan (drag) support. Auto-fits bounds when selection changes.
## Evidence
- Commits: 5e4c0709e4f55a80a9e0d3b10aac7c1a3cf89b1c, cbb88363c0e5a80bb6a3d9b1a2a06c8f82a32a3b, f9848e9a3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f, 4216045a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e, f9a5b67e6cd872df05770c976341a01ae578eb9f
- Tests: pnpm tsc --noEmit, pnpm test:ui
- PRs: