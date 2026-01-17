# fn-24-8my.1 Add merge UI and dialog

## Description
TBD

## Acceptance
- [ ] TBD

## Done summary
Added multi-select support (Ctrl+click) for project cards in GlobalView list, right-click context menu with Merge option, and MergeProjectsDialog component that allows combining multiple projects into a new file.
## Evidence
- Commits: c053e043199b9db62cc48b9a4989ab76e70c29c0
- Tests: pnpm tsc --noEmit, pnpm test:ui, cd src-tauri && cargo test
- PRs: