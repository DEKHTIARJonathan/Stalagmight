# Pitfalls

Lessons learned from NEEDS_WORK feedback. Things models tend to miss.

<!-- Entries added automatically by hooks or manually via `flowctl memory add` -->

## 2026-01-17 manual [pitfall]
Math.min/max with spread operator can cause stack overflow on large arrays - use reduce or loop instead

## 2026-01-17 manual [pitfall]
Frontend validation rules must match backend Validator exactly to avoid preview/import mismatches

## 2026-01-17 manual [pitfall]
Per-project settings need in-memory cache for new unsaved projects (no DB exists until first save)
