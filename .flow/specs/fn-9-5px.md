# Add section preview to DMP Import Dialog

## Overview

Add 250x250 MapLibre preview showing selected section shape with zoom/pan.

## Scope

- MapLibre-based preview (not SVG)
- 250x250 fixed size
- Station dots + shot lines
- Zoom (wheel) + pan (drag)
- Auto-fit on selection
- Minimal view (no labels)

### Out of Scope
- Labels in preview
- Editing in preview

## Quick commands

```bash
pnpm tsc --noEmit
pnpm test:ui
```

## Acceptance

- [ ] Preview panel visible
- [ ] Shows selected section
- [ ] Updates on selection change
- [ ] Zoom/pan works
- [ ] Auto-fits section
- [ ] Station dots visible
- [ ] Shot lines visible
- [ ] Tests pass

## References

- Task spec: `./tasks/task-06-section-preview.md`
- Reuse: SurveyLayer rendering
