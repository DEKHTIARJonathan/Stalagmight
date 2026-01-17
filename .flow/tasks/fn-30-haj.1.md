# fn-30-haj.1 Add Section model unit tests

## Description
Add comprehensive unit tests for the Section model in `src-tauri/src/models/section.rs`.

## Acceptance
- [x] Station calculation tests (via Section creation and shot management)
- [x] Offset logic tests (via apply_updates and SectionData roundtrip)
- [x] Direction field tests (SurveyDirection parsing, display, serde)
- [x] cargo test passes (124 unit tests + 72 integration tests)

## Done summary
Added 34 comprehensive unit tests for the Section model covering:
- SurveyDirection: default, display, FromStr, serde roundtrip
- SectionData: default values
- Section creation: empty, with metadata, with shots, direction defaults
- Shot management: add_shot, insert_shot_after, get_shot, remove_shot
- Section updates: apply_updates (all fields, partial, clear)
- Statistics: empty, single/multiple shots, virtual shots, negative depths
- Data conversion: to_section_data roundtrip
- SectionUpdates/SectionStats: default, serde

Also added Default impl for SectionData.

All tests pass: 124 unit + 72 integration tests.
## Evidence
- Commits:
- Tests: cargo test models::section::tests - 34 tests pass
- PRs: