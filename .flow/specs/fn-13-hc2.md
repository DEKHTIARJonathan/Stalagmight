# Add GPS coordinates input to Import Dialog

## Overview
GPS input with auto-detect for 7 formats: DD, DMS, DDM, UTM, MGRS, Plus Codes, What3words.

**HIGH RISK** - Many format combinations.

## Scope
- All 7 GPS formats supported
- Auto-detect format
- URL paste extraction
- Station selector for zero datum
- Works offline (API optional for Plus Codes/What3words)
- Store as DD, display per config
- Validation: lat -90 to 90, lon -180 to 180

## Approach
1. Create src/utils/gps.ts with parsers
2. Add GPS input section to DmpImportDialog
3. Format detection and validation
4. Station selector

## Quick commands
```bash
pnpm tsc --noEmit && pnpm test:ui
```

## Acceptance
- [ ] All 7 formats parse correctly
- [ ] Auto-detect works
- [ ] URL paste extracts coords
- [ ] Station selector works
- [ ] Validation shows errors
- [ ] Works offline
- [ ] Tests pass (mock APIs)

## References
- Task spec: `./tasks/task-10-gps-coordinates-input.md`
