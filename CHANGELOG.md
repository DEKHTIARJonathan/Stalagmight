# Changelog

All notable changes to Stalagmight will be documented in this file.

## [Unreleased]

## [0.0.8] - 2026-02-06

- fix(ci): avoid SIGPIPE in artifact collection step

## [0.0.7] - 2026-02-06

- fix(ci): add xdg-utils for AppImage bundling

## [0.0.6] - 2026-02-06

- fix(build): add bundle config to tauri.conf.json for release packaging

## [0.0.5] - 2026-02-06

- fix(release): extract changelog for body, fix artifact upload, add debug output

## [0.0.4] - 2026-02-06

- fix(release): replace tauri-action with direct build and Gitea API

## [0.0.3] - 2026-02-06

- chore: update Cargo.lock
- fix(release): rename awk variable to avoid gawk builtin conflict
- fix(release): use awk instead of sed for changelog insertion
- fix(tests): handle poisoned config mutex and skip root-incompatible test
- fix(ci): use XDG_CONFIG_HOME instead of HOME for test isolation
- fix(ci): set HOME for cargo test so config dir is writable
- test(e2e): add Playwright integration tests for recent features
- fix(ci): install Tauri system deps before cargo test
- chore: add release automation and CI workflows
- test: add unit tests for tile pipeline, providers, and tool groups
- test: add unit tests for recent features (config, recovery, settings helpers)
- docs: update TODO.md to reflect completed settings reset and corruption recovery
- test: add tier-1 unit tests for frontend utils and Rust persistence/models
- feat: add file corruption recovery dialog (SPEC 14.4)
- feat(settings): add per-setting reset-to-default buttons
- fix(tests): repair broken E2E mocks and align test expectations
- feat(data-table): add virtual scrolling for large tables
- docs: fix stale section header count in TODO.md
- docs: update TODO.md to reflect completed auto-save and i18n
- feat(data-table): apply decimal precision formatting to all numeric columns

## [0.0.1] - 2026-02-06

- Initial release
