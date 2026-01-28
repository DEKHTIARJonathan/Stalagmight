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

## 2026-01-22 manual [convention]
For keyboard shortcut detection with modifiers, use event.key.toLowerCase() to handle Shift+Z producing uppercase 'Z'

## 2026-01-22 manual [convention]
Use specific data-testid selectors instead of generic CSS selectors (input[type=number]) in E2E tests to avoid order-dependent failures

## 2026-01-23 manual [convention]
Use generation counter pattern for async cancellation instead of per-item pending sets that can race with clear operations

## 2026-01-23 manual [convention]
In WebdriverIO E2E tests, throw explicit errors in browser.execute callbacks when required globals (__E2E_TEST__, __cavechef_map__) are missing to get clear failures instead of confusing timeouts

## 2026-01-28 manual [convention]
Mock IPC handlers must return data matching the exact TypeScript interface (including all required fields); returning partial data silently reduces test fidelity

## 2026-01-28 manual [convention]
E2E test helpers on window.__E2E_TEST__ must be gated behind import.meta.env.DEV || import.meta.env.MODE === 'test' || import.meta.env.VITE_E2E === '1' to avoid leaking in production
