# Conventions

Project patterns discovered during work. Not in CLAUDE.md but important.

<!-- Entries added manually via `flowctl memory add` -->

## 2026-01-20 manual [convention]
Config structs need per-field #[serde(default)] for forward compatibility with partial TOML tables

## 2026-01-20 manual [convention]
Use dependency injection (accept fetch function as parameter) for testable network code - enables deterministic unit tests without real network calls
