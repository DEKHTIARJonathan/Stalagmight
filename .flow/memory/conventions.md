# Conventions

Project patterns discovered during work. Not in CLAUDE.md but important.

<!-- Entries added manually via `flowctl memory add` -->

## 2026-01-20 manual [convention]
Config structs need per-field #[serde(default)] for forward compatibility with partial TOML tables

## 2026-01-20 manual [convention]
Use dependency injection (accept fetch function as parameter) for testable network code - enables deterministic unit tests without real network calls

## 2026-01-21 manual [convention]
Place concurrency guards at store level (not hook level) when multiple UI paths can trigger the same action

## 2026-01-21 manual [convention]
Use single event listener at app root level to avoid duplicate subscriptions when components mount/unmount

## 2026-01-21 manual [convention]
Frontend color gradient interpolation should match backend algorithm (HSL vs RGB) to ensure preview matches export

## 2026-01-21 manual [convention]
WebdriverIO: use closest('[data-testid]') to detect focus on elements inside containers with data-testid when the focused element itself lacks the attribute

## 2026-01-21 manual [convention]
Only call event.preventDefault() when actually handling the event; no-op shortcuts should allow default browser behavior
