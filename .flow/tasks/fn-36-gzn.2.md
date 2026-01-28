# fn-36-gzn.2 Update SPEC.md and TESTING.md for 0-indexed station IDs

## Description

Update SPEC.md and TESTING.md to reflect 0-indexed station ID display convention, matching the code changes from task fn-36-gzn.1.

**Size:** S
**Files:**
- `docs/SPEC.md` — update 3 sections
- `docs/TESTING.md` — update 1 table row

## Approach

**SPEC.md changes:**
- Lines 490-496: Change "position is 1-indexed" to "station position is 0-indexed" and update formula `station_index + 1` → `station_index`. Update shot position description to clarify shots keep their own convention.
- Lines 549-556: Update shot-to-station mapping display positions. Change `display position = i + 1` → `display position = i` for stations.
- Lines 901-902: Update merge dialog mockup station numbers from 1-indexed (e.g., `#15`, `#1`) to 0-indexed (e.g., `#14`, `#0`).

**TESTING.md changes:**
- Lines 932-933: Update station link test ID description from "Position is 1-indexed" to "Position is 0-indexed".

## Key context

- Read current SPEC.md and TESTING.md content at the specified lines before editing to confirm exact text
- Shots are NOT changed — only station display positions change
- The `sectionId:position` format itself doesn't change, only the position value convention
## Acceptance
- [ ] SPEC.md lines 490-496 updated: station position described as 0-indexed
- [ ] SPEC.md lines 549-556 updated: station display positions use `station_index` (not `station_index + 1`)
- [ ] SPEC.md lines 901-902 updated: merge dialog mockup uses 0-indexed station numbers
- [ ] TESTING.md lines 932-933 updated: station link position described as 0-indexed
- [ ] Shot position documentation is NOT changed
- [ ] No other docs need updates (architecture.md, project-structure.md, configuration.md, roadmap.md verified clean)
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
