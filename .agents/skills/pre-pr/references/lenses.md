# Pre-PR Review Lenses

Assign exactly one numbered lens to each independent reviewer.

## 1. State invalidation and lifecycle

- Verify cached external state such as snap markers, ruler readouts, warning
  identity, clipboard matches, and MapLibre feature state is invalidated on the
  relevant mutation or re-derived before use.
- Rehydrate mutable objects after insert/delete by identity key such as shot ID or
  UUID, never by a captured index.
- MapLibre `setData()` wipes `setFeatureState`. Verify state is re-applied in the
  post-`setData` rebuild, not per hover. Prefer feature state over filters for
  per-feature visuals.

## 2. IPC and async correctness

- Review frontend TypeScript only for this lens: `src/hooks`,
  `src/components/Map`, and `src/store`.
- Every async IPC response that paints or mutates must capture project identity at
  request time and drop stale replies after undo, redo, reset, or project switch.
  Use the identity pattern near `projectIdentityKey` in
  `src/hooks/useMapTools.ts`.
- Geometry readiness is separate from project identity. The measured to adjusted
  geometry swap does not bump `modified_at`; check readiness-specific consumers in
  `src/components/Map/MapCanvas.tsx`.
- Confirm a reset context cannot accept an older in-flight response.
- Rust solved-geometry cache staleness is outside this lens.

## 3. Geometry and multi-section integrity

- Make inclusive and exclusive range boundaries explicit. Demand boundary tests.
- Every UUID or positional read, write, and delete path must also key by
  `section_id`. Test duplicate UUIDs across sections.
- Treat section and shot IDs as immutable foreign keys for merges, closures, and
  comments. Flag regeneration or reassignment.
- Metadata-only comment or LRUD edits must still touch the project and create undo,
  but must not run geometry reconciliation. Gate reconciliation on actual geometry
  changes, not the dirty/undo update.

## 4. Migration and persistence

- Do not persist transient defaults or freshly minted in-memory values before they
  are real. Restore using the current project's config, not `Config::default()`.
- Check read-only, legacy, missing-table, and `INSERT OR REPLACE` collision paths.
- Saves must remain atomic through temporary file plus rename. Flag direct
  overwrites.

## 5. UI and backend guard parity

- Every conditionally disabled mutation needs a backend guard that fails safe.
- Disable destructive actions until impact previews resolve, and verify the shown
  impact matches the offered actions.
- Nullable frontend guards must match the backend condition they imply, such as
  `databaseOpen` rather than a non-null file path.

## 6. Project landmines

- Telemetry is self-describing JSON plus gzip v3. Event names are sent verbatim.
  `src-tauri/src/telemetry/registry.rs` is only the canonical vocabulary backing
  coverage tests; registry order is irrelevant and there is no worker-side copy to
  synchronize. New commands use `command.<name>` and must be added there and to
  `src/utils/telemetry.ts`. Read `docs/telemetry.md` when relevant.
- IPC TypeScript types are generated. Never hand-edit `src/types/ipc/` or
  `src/types/ipc.generated.ts`; use `pnpm gen:ipc-types`. Read
  `docs/ipc-typegen.md` when relevant.
- Rust formatting and deny-level clippy are CI gates. Check surrounding style and
  `docs/linting.md`.
- The Rust and TypeScript file-size ratchets are CI gates. Flag growth past the
  baseline, new files at or above 1500 production LOC, any new/grown file over
  2000 production LOC, and new god files or god impls. A legitimate growth needs
  the matching baseline update in the same PR.
- Put heavy O(N) cross-checks behind `#[cfg(debug_assertions)]`. Use `debugLog()`
  rather than `console.log` on hot paths. Read `docs/debug-gates.md` and
  `docs/performance.md` when relevant.
- Check cross-platform path and tile URL handling. Windows Rust tests require
  `STALAGMIGHT_TEST_MANIFEST=1`; use `./scripts/test.ps1` on Windows.

## 7. Tests

- Look for adversarial boundary, duplicate-UUID, legacy-load, and hostile-input
  coverage rather than only happy paths.
- Parser tests should use golden fixtures under `e2e/fixtures` when appropriate.
- Flag new `waitForTimeout` usage as a likely Playwright flake source. It is not a
  lint rule, so do not claim the repository mechanically rejects it.
- Check whether the change drops coverage or invalidates a fixture silently.

## 8. Security

- Assume hostile input because the project is public.
- Review validation, path traversal, unsafe Rust, secret handling, command
  injection, and telemetry PII.

## 9. Goal and guarantee trace

- Infer the user-facing guarantee from the diff alone.
- Trace each guarantee end to end: trigger, state written, consumer, effect.
- Read the exact route, dialog, enum membership, or gating condition. Never assume
  the changed state is included in the consumer's checked set.
- Quote the consumer line. Treat a broken or unverifiable chain as a finding even
  if each individual hunk looks correct.

## 10. Independent general review

- Perform a broad findings-first code review independent of lenses 1 through 9.
- Prioritize correctness, behavioral regressions, data loss, security, CI failures,
  and missing tests.
- Report only traced findings, followed by residual risks if no findings remain.

## Known by design

Do not flag these without evidence the change alters the established behavior:

- Mid-section shot insertion intentionally renumbers later stations. See
  `insert_shot_after` and `insert_shot_before` in
  `src-tauri/src/models/project.rs`, plus the `CreateShot` comment in
  `src-tauri/src/core/state/commands.rs`.
- Existing `project.rs` formatting.
- `#[serde(default)]` config tolerance of unknown fields.
