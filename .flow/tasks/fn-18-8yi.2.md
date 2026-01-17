# fn-18-8yi.2 Add direction UI to Import Dialog

## Description
## Overview
Direction selector in Import Dialog.
## Files
- DmpImportDialog.tsx
## Acceptance
- [ ] Direction dropdown per section
- [ ] Editable
- [ ] Persists
- [ ] Tests pass
## Done summary
Added editable direction dropdown (In/Out) per section in Import Dialog. Direction defaults to parsed DMP value, can be edited before import, and persists correctly to the created section.
## Evidence
- Commits: bfcbae3d5e272f0ee55f895dddca93144b9f8a70
- Tests: pnpm tsc --noEmit, pnpm test:ui (134 passed), cd src-tauri && cargo test (62 passed)
- PRs: