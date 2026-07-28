# Quarantined WebdriverIO E2E suite (`e2e/legacy/`)

These WebdriverIO specs drive the **real Tauri application** (built debug binary +
`tauri-driver`/`tauri-wd`). They are **on-demand only** - they do **not** run in
any automated gate:

- **CI** runs `pnpm tsc --noEmit`, `cargo test --manifest-path src-tauri/Cargo.toml --features telemetry`, and the Playwright `@smoke` workflow (`e2e-smoke.yml`).
- The **pre-push** gate also runs the `@smoke` subset; the **full** Playwright suite runs nightly.
- **Releases** do not run this suite.

They live under `legacy/` because they are **15-20× slower** than the Playwright
suite (`e2e-playwright/`, mocked IPC) and most of them duplicate behavior the
Playwright suite already covers faster and more reliably.

**#120 cleanup (2026-06):** 13 rotted specs that failed on `master` were retired
after **verifying their coverage is preserved elsewhere**. The unique real-backend
assertions moved to **Rust** integration/unit tests (export PNG dpi-scaling in
`export/image.rs`; DMP buggy-EOS + corrupted in `parsers/dmp.rs`; reconcile
round-trips already in `core/reconcile.rs` + `core/state/collab.rs`), and the two
genuinely-unique UI cases - the import-section dialog and the shortcut-recorder
`aria-live` announcements - were ported to `e2e-playwright/`. The remaining 11 were
already duplicated. See git history for the retired specs.

## Running

```bash
# Full suite (auto-detects display / xvfb, rebuilds the debug binary if stale)
./scripts/wdio.sh

# One spec
./scripts/wdio.sh --spec e2e/legacy/specs/tml-import-integration.spec.ts

# Manual (Linux/Windows only; macOS uses tauri-wd)
pnpm test:e2e
```

Requirements: `tauri-driver` (Linux/Windows) or `tauri-wd` (macOS), a display or
`xvfb`, and a debug build (`pnpm tauri build --debug --no-bundle`). See
[../../docs/TESTING.md](../../docs/TESTING.md).

## What's worth running (unique backend coverage)

These exercise behavior Playwright's mocked-IPC layer **cannot** - real file I/O,
real backend parsing/serialization, real cross-session persistence, native
rasterization, and large-dataset stress. If you touch those areas, run the
relevant spec here before a release:

| Spec | Why it can't be a Playwright test |
|------|-----------------------------------|
| `tml-import-integration.spec.ts`, `tml-export-integration.spec.ts`, `tml-closure-import.spec.ts`, `tml-excluded-shots.spec.ts` | Real TML parse/serialize round-trips through the backend |
| `project-persistence.spec.ts` | Real filesystem save/load across app sessions |
| `save-now-single-write.spec.ts` | Real write coordination (single-write invariant) |
| `fractal-data-generation.spec.ts` | Large-dataset stress / perf against the real backend |

> Export (CSV/JSON/PNG/SVG + dpi scaling), `.dmp` parsing, and collab `.tml`
> reconcile round-trips used to live here too (`export-integration`,
> `export-scaling`, `dmp-integration`, `collab-roundtrip`) - retired in #120; that
> coverage is now in Rust tests (`export/image.rs`, `parsers/dmp.rs`,
> `core/reconcile.rs`, `core/state/collab.rs`), which run on every CI `cargo test`.

## What's duplicated by Playwright (redundant - low priority to maintain)

UI/interaction specs whose behavior is already covered, faster, by
`e2e-playwright/`: `map-controls-styling`, `map-integration`,
`map-interactions`, `multi-section-workflows`, `depth-gradient`,
`reference-shots-filter`, `project-lifecycle`.

(The duplicated specs that were also **failing on `master`** - `keyboard-shortcuts`,
`zoom-tool`, `satellite-display`, `detail-panel-center`, `section-highlighting-a11y`,
`shortcuts-accessibility`, `undo-redo-integration`, `import-section-dialog`,
`export-accessibility` - were deleted in #120; the Playwright twins
(`map-tools`, `zoom-tool`, `satellite-*`, `detail-panel-links`, `settings-shortcuts`,
`undo-redo-dropdown`, `section-highlighting`, plus the two new ports) cover them.)

Prefer adding new UI coverage to `e2e-playwright/`, not here. Tracked under #23.

## Logic-level seed helpers (NOT import-UI coverage)

Some helpers in `helpers/app.ts` are named like an import - `importDmpViaStore`,
`importTmlViaStore`, `createSectionViaStore` - but **bypass the import wizard UI**.
They parse via the real backend and call the store's `createSection` /
`executeTmlImport` directly to get sections into the project quickly. They are
**setup/seed utilities, not coverage of the import flow**: a spec that "imports"
a file through them is *not* exercising the selection → zero-datum → placement →
orphan-connection dialogs.

| Helper | What it really does | Where the import *UI* is covered |
|--------|---------------------|----------------------------------|
| `importDmpViaStore(path)` | Parses `.dmp` (real backend) → `createSection` per section | `import-dmp-dialog.spec.ts`; Playwright `dmp-import` |
| `importTmlViaStore(path)` | Real `executeTmlImport`, no dialog | `tml-import-integration.spec.ts` (`openTmlImportWithFile` → dialog confirm) |
| `createSectionViaStore(data)` | `createSection` directly, no dialog | `import-section-dialog.spec.ts`; Playwright |

To assert the import *experience*, drive the wizard instead
(`openDmpImportWithFile` + `placeAllSectionsInDmpWizard`), or write a Playwright /
component test.
