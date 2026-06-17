# Quarantined WebdriverIO E2E suite (`e2e/legacy/`)

These WebdriverIO specs drive the **real Tauri application** (built debug binary +
`tauri-driver`/`tauri-wd`). They are **on-demand only** — they do **not** run in
any automated gate:

- **CI** runs only `pnpm tsc --noEmit` + `cargo test --features telemetry`.
- The **pre-push** gate runs the fast Playwright `@smoke` subset.
- **Releases** do not run this suite.

They live under `legacy/` because they are **15–20× slower** than the Playwright
suite (`e2e-playwright/`, mocked IPC) and **~85% of them duplicate** behavior that
the Playwright suite already covers faster and more reliably. Nothing here was
deleted — full history and coverage are preserved, and the suite stays runnable.

## Running

```bash
# Full suite (auto-detects display / xvfb, rebuilds the debug binary if stale)
./scripts/wdio.sh

# One spec
./scripts/wdio.sh --spec e2e/legacy/specs/export-integration.spec.ts

# Manual (Linux/Windows only; macOS uses tauri-wd)
pnpm test:e2e
```

Requirements: `tauri-driver` (Linux/Windows) or `tauri-wd` (macOS), a display or
`xvfb`, and a debug build (`pnpm tauri build --debug --no-bundle`). See
[../../docs/TESTING.md](../../docs/TESTING.md).

## What's worth running (unique backend coverage)

These exercise behavior Playwright's mocked-IPC layer **cannot** — real file I/O,
real backend parsing/serialization, real cross-session persistence, native
rasterization, and large-dataset stress. If you touch those areas, run the
relevant spec here before a release:

| Spec | Why it can't be a Playwright test |
|------|-----------------------------------|
| `export-integration.spec.ts` | Real CSV/JSON/PNG/SVG files written to disk and inspected |
| `export-scaling.spec.ts` | Real `resvg` rasterization / pixel-accurate SVG scaling |
| `tml-import-integration.spec.ts`, `tml-export-integration.spec.ts`, `tml-closure-import.spec.ts`, `tml-excluded-shots.spec.ts` | Real TML parse/serialize round-trips through the backend |
| `dmp-integration.spec.ts` | Real `.dmp` parsing with real file I/O |
| `project-persistence.spec.ts` | Real filesystem save/load across app sessions |
| `save-now-single-write.spec.ts` | Real write coordination (single-write invariant) |
| `collab-roundtrip.spec.ts` | Real sibling `.tml` save/reconcile round-trip |
| `fractal-data-generation.spec.ts` | Large-dataset stress / perf against the real backend |

## What's duplicated by Playwright (redundant — low priority to maintain)

UI/interaction specs whose behavior is already covered, faster, by
`e2e-playwright/`: `back-button`, `keyboard-shortcuts`, `map-controls-styling`,
`map-integration`, `map-interactions`, `multi-section-workflows`, `zoom-tool`,
`satellite-display`, `depth-gradient`, `detail-panel-center`,
`section-highlighting-a11y`, `shortcuts-accessibility`, `reference-shots-filter`,
`project-lifecycle`, `undo-redo-integration`, `import-dmp-dialog`,
`import-section-dialog`, `export-accessibility`.

Prefer adding new UI coverage to `e2e-playwright/`, not here. Tracked under #23.
