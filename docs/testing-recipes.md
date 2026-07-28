# Testing Recipes

Lookup reference: commands, per-framework patterns, mock and fixture
conventions, and the traps that have cost real debugging time.

For *which tier a test belongs in*, and the testability contract a component has
to satisfy, see the [Testing Guide](TESTING.md).

## Commands

The authoritative pre-push list lives in the Pre-Push Checklist in
[`CLAUDE.md`](../CLAUDE.md). These are the per-tier commands.

### Vitest (unit + component)

```bash
pnpm exec vitest run                        # one-shot, all files
pnpm exec vitest run src/store              # one-shot, a subtree
pnpm exec vitest run --coverage             # reports under docs/coverage/
CI=1 pnpm test:all                          # vitest, then the full Playwright suite
```

**Trap: `pnpm test` runs vitest in WATCH mode locally.** The `test` script is
bare `vitest`, which only runs once when it detects `CI`. In a local or agent
shell with no `CI` env it watches forever and a piped or backgrounded invocation
never returns. Use `pnpm exec vitest run` (or `CI=1 pnpm test`) for a
deterministic run. CI is unaffected.

### Playwright

```bash
pnpm test:ui                # full suite
pnpm test:ui:smoke          # the @smoke subset (what CI's smoke job runs)
pnpm test:ui:headed         # visible browser
pnpm test:ui:debug          # Playwright inspector, step through
pnpm exec playwright test e2e-playwright/theme.spec.ts        # one spec
pnpm exec playwright test --grep "closes on Escape"           # by title
pnpm lint:e2e-parallel      # parallel-safety scanner (a CI smoke-job gate)
```

**Trap: `pnpm <script> -- <flags>` does not work.** pnpm forwards the `--`
literally, so `pnpm test:ui -- --reporter=json` runs
`playwright test -- --reporter=json`, and Playwright reads the `--` as a
positional test filter: "No tests found", exit in about a second. Use
`pnpm exec playwright test <flags>`.

Playwright auto-starts the Vite dev server on `:1420` via the `webServer` config
and reuses an already-running one locally. If you run more than one clone of
this repo, that reuse will silently point the suite at the *other* clone's
server, so you test the wrong code with no error. Do not kill theirs: start your
own on a free port (`pnpm exec vite --port 1421`) and run against a config whose
`baseURL` and `webServer.url` point at it.

### Rust

```bash
# What CI runs. --features telemetry is REQUIRED (see below).
TELEMETRY_ENDPOINT=http://localhost/dummy \
  cargo test --manifest-path src-tauri/Cargo.toml --features telemetry

cargo test --manifest-path src-tauri/Cargo.toml parser            # by name
cargo test --manifest-path src-tauri/Cargo.toml -- --nocapture    # show println!
```

**Trap: a plain `cargo test` can pass while CI fails.** The
`registry_covers_all_*` telemetry-registry coverage tests are gated behind the
`telemetry` feature, so a plain run filters them out. `build.rs` also *requires*
`TELEMETRY_ENDPOINT` to be set when building with that feature.

**Trap: on Windows, run the Rust tests via `./scripts/test.ps1`.** That script
sets `STALAGMIGHT_TEST_MANIFEST=1` (and the telemetry feature + endpoint).
Without it every `cargo test` harness binary aborts at startup with
`STATUS_ENTRYPOINT_NOT_FOUND` (`0xC0000139`) before a single test runs: the
loader binds to comctl32 v5, which lacks `TaskDialogIndirect` (statically
imported via rfd / tauri-plugin-dialog). The env var makes `build.rs` delay-load
comctl32 for test binaries. The shipping app is unaffected.

### WebdriverIO (real Tauri app, on-demand)

```bash
./scripts/wdio.sh                                                  # full suite
./scripts/wdio.sh --spec e2e/legacy/specs/tml-import-integration.spec.ts
./scripts/wdio.sh --rebuild        # force a rebuild first
./scripts/wdio.sh --headed         # force headed (fail if there is no display)
./scripts/wdio.sh --headless       # force xvfb
./scripts/wdio.sh --skip-build     # skip freshness checks (see the stale-binary trap)
```

Flags combine, e.g. `./scripts/wdio.sh --skip-build --spec e2e/legacy/specs/project-persistence.spec.ts`.

`wdio.sh` handles platform detection, driver installation checks, display
detection (xvfb when headless), port cleanup of stale drivers, and build
freshness. Prefer it over the raw commands.

The raw equivalents, for when you need to bypass the wrapper:

```bash
pnpm test:e2e                                    # builds, then runs
xvfb-run -a pnpm test:e2e                        # headless Linux
SKIP_BUILD=1 xvfb-run -a pnpm test:e2e           # reuse an existing binary
WDIO_MAX_INSTANCES=4 xvfb-run -a pnpm test:e2e   # N parallel workers
SKIP_BUILD=1 npx wdio run wdio.conf.ts --spec e2e/legacy/specs/map-interactions.spec.ts
```

Running one spec manually requires `npx wdio run wdio.conf.ts --spec <file>`;
`pnpm test:e2e -- --spec <file>` does not pass the flag through.

### Agent harness

```bash
pnpm agent:smoke
pnpm agent:scenarios
```

Requires Node 22. See [Agent Harness](agent-harness.md).

### Typecheck

```bash
pnpm tsc --noEmit          # src/ only - tsconfig.json includes nothing else
pnpm typecheck:agent       # e2e/agent + e2e/lib (tsconfig.agent.json)
pnpm typecheck:playwright  # e2e-playwright/ + playwright.config.ts
```

The first two are `check` gates, the third is a `smoke` gate - it has to be,
because `check` path-ignores `e2e-playwright/**`.

`e2e/legacy/` is the one *test* tree nothing type-checks. `tsconfig.e2e.json`
exists but is deliberately not gated: the quarantined WDIO suite has 606
pre-existing errors (mostly the ambient `browser` global and untyped hook
parameters) and runs in no automated job, so gating it would mean fixing 606
errors in code that is on its way out. Some non-test files are ungoverned too -
`scripts/**/*.ts`, `vite.config.ts`, `wdio.replay.conf.ts`, `src-tauri/bindings/`
are in no tsconfig's `include`.

Note the strictness difference: `tsconfig.playwright.json` is `strict`, but
unlike the root config it does not set `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `noUnusedLocals`/`noUnusedParameters`,
`noImplicitReturns`, or `noFallthroughCasesInSwitch`. "The specs are
type-checked" is true but weaker than what `src/` gets.

The agent harness runs under `tsx`, which transpiles without type-checking, and
it is exercised on demand only, so `typecheck:agent` (a CI `check` step) is the
only thing standing between it and silent rot.

### Coverage

```bash
pnpm exec vitest run --coverage   # unit + component -> docs/coverage/
pnpm coverage:ui             # instrument the app, run Playwright
pnpm coverage:e2e            # instrument the app, run WebdriverIO
pnpm coverage:merge          # merge raw E2E output into docs/coverage/
```

## Vitest patterns

The suite is defined by `vite.config.ts` `test.include`, which is wider than
`src/`: it also picks up `scripts/**/*.{test,spec}.ts` (golden tests for the
repo's own Node tooling) and `e2e/agent/lib/**/*.test.ts` (agent-harness helper
logic). A new vitest home outside those three globs is a deliberate one-line
addition there.

Tiering is by **file extension**, via `environmentMatchGlobs`:

| Extension | Environment | Use for |
|-----------|-------------|---------|
| `*.{test,spec}.ts` | `node` | Pure logic - stores, utils, selectors, formatters. No DOM. |
| `*.{test,spec}.tsx` | `jsdom` | Rendering a React component with Testing Library. |

Naming a DOM test `.ts` puts it in the `node` environment where `document` does
not exist. Use `.tsx` even when the file contains no JSX.

`src/test/setup.ts` registers jest-dom matchers, provisions the `#dialog-root`
element that `DialogWrapper` portals into (without it, every dialog component
test renders nothing), and auto-unmounts React trees between tests. The DOM
pieces load lazily behind a `document` guard, so `node` tests pay no DOM cost.

### A component test

Render the real component and assert on accessible roles and handler calls:

```tsx
import { it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from './Button';

it('fires onClick when activated', async () => {
  const onClick = vi.fn();
  render(<Button onClick={onClick}>Import</Button>);
  await userEvent.click(screen.getByRole('button', { name: 'Import' }));
  expect(onClick).toHaveBeenCalledTimes(1);
});
```

`src/components/common/Button.test.tsx` is the harness smoke test. Components
that read Zustand stores or `react-i18next` need those mocked or provided; keep
early component tests on leaf components to avoid heavy setup.

This tier mocks IPC - persistence is owned by the Rust tier, see
[Rust patterns](#rust-patterns).

## Playwright patterns

Specs live in `e2e-playwright/`, flat, one file per feature area, alongside:

```
e2e-playwright/
├── helpers/app.ts          # shared setup + waiters (import from here)
├── mocks/tauri-ipc.ts      # the mocked Tauri IPC backend
├── fixtures/coverage.ts    # the test fixture every spec imports `test` from
├── fixtures/*.dmp          # binary survey files. Nothing reads them: the mock
│                           #   fabricates data and never parses a file
└── <feature>.spec.ts
```

`playwright.config.ts`: Chromium only, `fullyParallel`, base URL
`http://localhost:1420`, 30 s test timeout, 5 s expect timeout, retries 2 in CI
and 1 locally (`PW_RETRIES` overrides), workers `100%` in CI (`PW_WORKERS`
overrides; a bare integer and a percentage string both work, because the config
coerces the integer form itself - raw Playwright would reject it, #132). Traces
on first retry, screenshots and video on failure, all under `test-results/`.

### Basic structure

```typescript
import { test, expect } from './fixtures/coverage';
import { setupMockedPage, createProject, waitForMapReady } from './helpers/app';

test.describe('Feature Name', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
  });

  test('does the thing @smoke', async ({ page }) => {
    await createProject(page, 'Test Project');
    await waitForMapReady(page);
    await expect(page.getByTestId('map-canvas')).toBeVisible();
  });
});
```

Import `test` from `./fixtures/coverage`, not from `@playwright/test` - that
fixture is what wires up E2E coverage collection.

### Waiters

Use these instead of `waitForTimeout`. All from `helpers/app.ts`:

| Helper | Waits for |
|--------|-----------|
| `setupMockedPage(page)` | Mocks installed and the app booted |
| `waitForAppReady(page)` | App shell mounted |
| `waitForMapReady(page)` | The map is initialized and interactive |
| `waitForMapIdle(page)` | Pan/zoom animation settled |
| `waitForActiveTool(page, tool)` | The toolbar has switched tool |
| `waitForDialogClosed(page, testId)` / `waitForNoDialogs(page)` | Dialog teardown |
| `waitForDrawnStations` / `waitForDrawnShots` | The custom WebGL layer has drawn N features |

`helpers/app.ts` also has seeding helpers (`createSectionViaStore`,
`seedProjectWithSections`), menu navigation (`openAppMenu`,
`openSettingsFromMenu`, `openImportFromMenu`), the DMP wizard drivers
(`openDmpSelectionDialog`, `proceedToDmpImportWizard`, `placeAllSections`), and
canvas readback (`getDrawnGeometry`, `getStationScreenPositions`,
`readCanvasPixel`, `countCanvasInk`). Read the file before writing a new
one-off helper.

A waiter that is genuinely local to one spec stays in that spec -
`waitForZoomChange` in `zoom-tool.spec.ts` is the pattern.

### Parallel-safety invariant

This tier runs `fullyParallel` at multiple workers. That is safe because of the
architecture, not per-test discipline:

- IPC is mocked **per page**; all backend state lives on `window.*` inside each
  isolated browser context.
- The single shared `webServer` (Vite, `:1420`) is **stateless** - it serves the
  bundle only.
- The one real disk write (`fixtures/coverage.ts`) is uniquely named per
  `test + workerIndex` and gated behind `E2E_COVERAGE=1`.

So a spec must never introduce state that survives across pages or workers.
`pnpm lint:e2e-parallel` (`scripts/check-e2e-parallel-safe.mjs`) fails on:

| Rule | Pattern |
|------|---------|
| `own-server` | `createServer(` |
| `port-listen` | `.listen(` |
| `disk-write` | `writeFileSync`, `writeFile`, `appendFileSync`, `appendFile`, `createWriteStream`, `copyFileSync`, `cpSync`, `renameSync` |
| `foreign-host-port` | `localhost:<port>` / `127.0.0.1:<port>` for any port but `:1420` |
| `serial` | `describe.serial` / `test.serial` / `mode: 'serial'` |

It runs in the **smoke** CI job - the only job that runs on
`e2e-playwright/**` changes, since `check` path-ignores them. Run it locally
before pushing. `fixtures/coverage.ts` is the one allow-listed write; a genuinely
necessary exception goes in the `ALLOW` list in that script *with a written
reason*. The scanner is a line-based tripwire, not a parser: it deliberately
ignores `page.screenshot({path})` (framework I/O with unique names) and the root
`playwright.config.ts`.

On a 2-core runner at multiple workers, bad hygiene here surfaces as flake, not
as a clean failure.

### Opening and closing dialogs

Prefer a helper, then the store, then a keypress.

```typescript
// Via the store - the most reliable
await page.evaluate(() => {
  (window as any).__E2E_TEST__.uiStore.getState().openDialog('import');
});
await page.waitForSelector('[data-testid="import-section-dialog"]');
```

`Ctrl+I` is the `import_dmp` action. It does **not** open a dialog directly - it
opens the native file picker, which the mock answers with
`/mock/test-survey.dmp`, and the app then routes by extension into
`DmpSelectionDialog`. That is why `openDmpSelectionDialog(page)` presses
`Control+i` and then waits for `dmp-selection-dialog`. Two consequences: the
shortcut is a no-op when editing is blocked (read-only map / Plan or Export mode
/ locked remote project), and it never opens `ImportDialog` (manual section
creation) - use the store for that.

Closing:

```typescript
// Cancel button
await page.getByTestId('new-project-dialog')
  .getByTestId('new-project-cancel-button').click();

// Escape - DialogWrapper closes the TOPMOST dialog
await page.keyboard.press('Escape');
```

| Method | Works | Notes |
|--------|-------|-------|
| Cancel / Close button | Yes | Preferred in tests |
| Backdrop click | Yes | Calls `onClose` |
| Escape | Yes | `DialogWrapper` closes the topmost dialog; `src/utils/dialogStack.ts` sets `inert` on everything underneath |

Two Escape edge cases that read as flake: Escape is a **no-op while a dropdown is
open** (`[data-dropdown-open]`) because the dropdown consumes it first, and on a
**dirty** dialog (`isDirty`) it opens the discard confirmation rather than
closing - a second Escape dismisses the confirmation and leaves the dialog open.

### The DMP import flow

Three dialogs, in order, all driven from `helpers/app.ts`:

| Dialog | `activeDialog` | Reached by |
|--------|----------------|------------|
| `DmpSelectionDialog` | `'dmp-selection'` | `openDmpSelectionDialog(page)` (Ctrl+I -> mocked picker) |
| `ZeroDatumSelectionDialog` / `ZeroDatumConfigDialog` | `'zero-datum-selection'` / `'zero-datum-config'` | Continue from selection, when the project has no zero datum |
| `DmpNewImportDialog` | `'dmp-import-new'` | Continue from selection or from zero-datum config |

`ImportDialog` (`'import'`, manual section creation) is a separate flow, opened
by the SectionsPanel "+" button or via the store. `e2e-playwright/dmp-import.spec.ts`
and `import-section-dialog.spec.ts` are the worked examples.

Step 1 selection stats live under `[data-testid="selection-stats"]` with
`stats-shot-count`, `stats-total-length`, `stats-depth-range` inside; the
container's `aria-label` spells out the whole thing
(`"Selection statistics: 70 shots, 281.8m total length, depth range 2.1-15.4m"`,
`"depth range --"` when there is no depth data), so assert on the label when you
want one stable string instead of three.

### Canvas interaction

```typescript
import { waitForMapReady, waitForMapIdle } from './helpers/app';

await waitForMapReady(page);
const mapCanvas = page.getByTestId('map-canvas');
await mapCanvas.click();

const box = await mapCanvas.boundingBox();
if (box) {
  await page.mouse.move(box.x + 100, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + 200, box.y + 200);
  await page.mouse.up();
  await waitForMapIdle(page);
}
```

`MapCanvas` exposes two hooks for assertions: `window.__stalagmight_map__` (the
MapLibre `Map`) and `window.__stalagmight_to_meters__`,
`(lng, lat) => { x, y }` in meters, using the same transform and the same live
GPS origin the component commits with (`src/dev/mapE2eHooks.ts`). Predict an
expected offset with that hook rather than a linear degrees-to-meters constant -
the two diverge by several percent.

### Debugging a failing spec

1. `pnpm test:ui:debug` - Playwright inspector, step through the run.
2. `pnpm test:ui:headed` - watch it happen.
3. Check `test-results/` for the screenshot, video, and trace (traces are
   captured on first retry).
4. `PW_RETRIES=0` to fail fast instead of watching a flake pass on retry.
5. Add `console.log()` inside the relevant mock handler in
   `mocks/tauri-ipc.ts`.

`e2e-playwright/debug.spec.ts` is a minimal end-to-end sanity spec (create a
project, assert the map canvas renders) - useful to confirm the harness itself
works before blaming your test.

## Mocked IPC conventions

`e2e-playwright/mocks/tauri-ipc.ts` intercepts `__TAURI_INTERNALS__.invoke()`
and hand-simulates the Rust backend for every Playwright spec.

### A new IPC command needs a mock case

Unknown commands hit `default: console.warn(...); return null`, so
`result.success` is falsy and the UI silently takes its failure path - the spec
fails for the wrong reason, or worse, passes vacuously.

```typescript
case 'your_new_command': {
  const param = args?.param_name as string;
  return { success: true, data: mockData };   // shape must match the Rust return type
}
```

`src/test/__tests__/mockContract.test.ts` (vitest) enforces this in both
directions: it parses `generate_handler!` in `src-tauri/src/lib.rs` and the
mock's `switch` cases and fails on drift, with reasoned allowlists and
stale-allowlist self-checks. **Adding or removing a `#[tauri::command]` fails
vitest until the mock and the allowlist agree.**

It is gated from both sides: `check` runs it as part of the vitest suite when
Rust or `src/` changes, and `smoke` runs it on its own (`pnpm test:mock-contract`)
when `e2e-playwright/**` changes, which `check` path-ignores.

### Do not copy backend shapes into a test

`Project`, `ProjectStats`, and `Config` are ts-rs-generated in
`src/types/ipc/`. Build mock payloads against those types
(`src/types/ipc/Project.ts`, `ProjectStats.ts`, `Config.ts`; `src/types/config.ts`
re-exports them alongside the hand-written display defaults) instead of
hand-listing fields, and let `tsc` catch a missing one. `Config` in particular
has around twenty top-level blocks and grows.

Two specific gaps to watch:

- **A new Settings *category* needs its config block in the mock.** A panel that
  reads `config.<block>.*` directly crashes when the block is absent (the real
  config always has it via `#[serde(default)]`), so the panel never renders and
  the category-iterating tests in `settings-dialog.spec.ts` fail. There are
  **two** config objects in the mock to update.
- **`focus-management.spec.ts` hardcodes the Settings category order** for its
  roving-tabindex assertions. A new category shifts ArrowDown navigation.

Both are full-suite-only failures: `@smoke` and the CI smoke job do not catch
them. Run the full local Playwright suite for any Settings-category change.

### `get_project_state` must return a FRESH identity per call

The mock deep-clones (`structuredClone(currentProject)`) on every
`get_project_state`, mirroring the real Tauri IPC, which returns
`project.clone()` serialized over the boundary - a brand-new object and brand-new
nested arrays every refetch.

The mock mutates `currentProject`'s arrays **in place** (`sections`,
`zero_datums`, `loop_closures`, `station_merges` via `.push` / `.splice`).
Returning the same reference freezes every reference-keyed React memo
(`useMemo(..., [project?.sections])` and friends), and the symptom is
distinctive: **a panel or overlay renders empty while the footer or stats show
the populated count.** Real users never see it - real IPC returns fresh
references. Do not "optimize" the clone away.

### A new gate must not read state the mock never sets

Sibling failure class: a new frontend gate reads store state the e2e environment
never initializes, silently disabling UI in every spec. The fix is always to
make the **mock** mirror the real invariant, never to weaken the gate. The
worked example is `__MOCK_SET_PROJECT_PATH__`, which sets `databaseOpen: true`
for a non-null path and `false` for null, because the real load path does.

### Recording calls for assertions

The mock exposes `window.__MOCK_*` hooks - recorded call arrays
(`__MOCK_MOVE_CALLS__`, `__MOCK_EXECUTE_BATCH_CALLS__`,
`__MOCK_CREATE_SHOT_CALLS__`, `__MOCK_SPLIT_SHOT_CALLS__`, ...), setters that
force a scenario (`__MOCK_SET_GEOMETRY_ERROR__`, `__MOCK_SET_INTEGRITY_ISSUES__`,
`__MOCK_CONNECTIVITY_RESULT__`, `__MOCK_IPC_OVERRIDES__`, ...), and matching
resets. Grep the mock for `__MOCK_` for the current list; follow the existing
naming when you add one.

The `move_*` handlers are **no-ops that do not mutate the project** (the app
refetches generated coordinates), so assert on the *recorded* call, not on a
coordinate read-back.

The mock also hardcodes station `z = 0` in `get_project_state` - it does not
derive station depth from the seeded shot `depth_in`/`depth_out`, even though
the stored *shots* carry them. Any e2e reading a station `z` or a depth readout
sees `0` regardless of the seed. Assert that a depth row *renders*; pin the depth
math in a Rust unit test.

### Common mock scenarios

```typescript
// A geometry command that fails, to exercise the error path
case 'get_survey_geometry_for_file': {
  const filePath = args?.path as string;
  if (filePath.includes('error')) throw new Error('Failed to load geometry');
  return {
    shots: [{ from: [-81.78, 24.55], to: [-81.77, 24.56], kind: 'Normal', section_id: 1 }],
    origin: [-81.78, 24.55],
  };
}

// The undo/redo stacks
case 'get_undo_stack': {
  return [{
    index: 0,
    description: 'Create section "Main Line"',
    timestamp: new Date().toISOString(),
    commandType: 'create_section',
    previewData: {
      changes: [{ field: 'name', oldValue: '', newValue: 'Main Line' }],
      additionalChanges: 0,
    },
  }];
}
```

Mocked specs run with a non-null `gpsOrigin`, which changes how station
coordinates are computed - see the canvas-interaction section above before
asserting on any distance or offset.

## Per-component Playwright recipes

### Undo/redo history dropdown

| Element | `data-testid` |
|---------|---------------|
| Trigger buttons | `toolbar-undo-button`, `toolbar-redo-button` |
| Dropdown (`role="menu"`) | `toolbar-undo-button-dropdown`, `toolbar-redo-button-dropdown` |
| Item (index matches `item.index` in the stack) | `toolbar-undo-button-item-{index}` |
| Detail preview | `detail-preview-popup` |
| Chevrons (visible when the stack is non-empty) | `undo-chevron`, `redo-chevron` |
| Loading spinner (shown while an action is in flight) | `toolbar-undo-button-loading`, `toolbar-redo-button-loading` |
| `aria-live` announcer (remaining action count) | `toolbar-undo-button-announcement`, `toolbar-redo-button-announcement` |
| Error dialog | `error-dialog`, `error-dialog-stack-trace`, `error-dialog-copy-btn` |

Opens on hover after a **300 ms** delay; the mouse-leave close has a **100 ms**
buffer.

```typescript
await page.hover('[data-testid="toolbar-undo-button"]');
await expect(page.getByTestId('toolbar-undo-button-dropdown')).toBeVisible({ timeout: 1000 });
```

**Keyboard open sets the active item in a `setTimeout(0)`.** Always wait for
`aria-activedescendant` before asserting on navigation state:

```typescript
await page.focus('[data-testid="toolbar-undo-button"]');
await page.keyboard.press('ArrowDown');
await page.waitForFunction(() => {
  const menu = document.querySelector('[role="menu"]');
  return menu && menu.getAttribute('aria-activedescendant');
});
await page.keyboard.press('ArrowDown');   // second item
await page.keyboard.press('Enter');       // select and close
```

Close paths: item click, Enter on the active item, mouse leave, Escape, click
outside, empty stack. **Stay-open** paths: clicking the trigger button and
`Ctrl+Z`/`Ctrl+Y`, which refresh the items in place.

```typescript
// Escape
await page.keyboard.press('Escape');
await expect(page.locator('[role="menu"]')).not.toBeVisible();

// Click outside (mousedown)
await page.click('body', { position: { x: 10, y: 10 } });

// Item click closes
await page.click('[data-testid="toolbar-undo-button-item-0"]');
await expect(page.getByTestId('toolbar-undo-button-dropdown')).not.toBeVisible();
```

Every stay-open, empty-stack, announcement, and error test must **open the
dropdown first** (hover or keyboard), then act:

```typescript
// Button click keeps it open and shows the spinner
await page.click('[data-testid="toolbar-undo-button"]');
await expect(page.getByTestId('toolbar-undo-button-loading')).toBeVisible();
await expect(page.getByTestId('toolbar-undo-button-dropdown')).toBeVisible();

// Ctrl+Z keeps it open and refreshes (focus must NOT be in a text input)
await page.keyboard.press('Control+z');
await expect(page.getByTestId('toolbar-undo-button-dropdown')).toBeVisible();

// Announcement after an action
await expect(page.getByTestId('toolbar-undo-button-announcement'))
  .toContainText('actions remaining');

// Empty stack auto-closes: point the mock at an empty get_undo_stack, then act
await page.click('[data-testid="toolbar-undo-button"]');
await expect(page.getByTestId('toolbar-undo-button-dropdown')).not.toBeVisible();

// Failure opens the error dialog and the dropdown STAYS open
// (mock undo -> { success: false, error: 'Stack corrupted' })
await page.click('[data-testid="toolbar-undo-button"]');
await expect(page.getByTestId('error-dialog')).toBeVisible();
await expect(page.getByTestId('toolbar-undo-button-dropdown')).toBeVisible();
```

The detail preview appears on item hover with **no** delay:

```typescript
await page.locator('[data-testid="toolbar-undo-button-item-0"]').hover();
await expect(page.getByTestId('detail-preview-popup')).toBeVisible();
```

### `Select` (portaled dropdown)

`Select` renders its listbox via `createPortal` into `document.body` with
`position: fixed`. The listbox is **not** inside the Select's container - it is a
sibling of `<div id="root">`.

1. **Do not locate it by an `.absolute` class.** The portaled listbox has none.
2. **Do not scope options under the Select container.**
   `selectContainer.locator('[role="option"]')` finds nothing.
3. **Use `document.elementFromPoint()` to prove z-order.** `toBeVisible()` alone
   cannot tell you an element is behind a sticky header.

```typescript
const trigger = page.getByTestId('select-number-format').locator('button').first();
await trigger.click();

// aria-controls may need a render cycle. Use an attribute selector - React
// useId() produces IDs containing colons, which break #id selectors.
await expect(trigger).toHaveAttribute('aria-controls', /.+/);
const listboxId = await trigger.getAttribute('aria-controls');
const listbox = page.locator(`[id="${listboxId}"]`);

await listbox.locator('[role="option"]:has-text("Decimal")').click();
```

Prefer the `aria-controls` lookup over `page.getByRole('listbox')` whenever
another listbox may be mounted (the sections panel has one).

```typescript
// Z-order proof
const box = await firstOption.boundingBox();
const isTopmost = await page.evaluate(({ x, y }) => {
  return document.elementFromPoint(x, y)?.closest('[role="listbox"]') !== null;
}, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
expect(isTopmost).toBe(true);
```

Scroll behavior: **external** scroll (window, a table container) closes the
dropdown; **internal** scroll - through the options, or `scrollIntoView` from
keyboard navigation - does not. The mechanism is a `scrollSafe` list passed to
`useDismissableLayer` covering the listbox and its nearest scrollable ancestor.
If a portaled popover self-closes the instant it opens, the trigger's scroll
container is missing from that list; fix it there, not with a settle timer.

`aria-activedescendant` is set **synchronously** from React state here - no
`setTimeout` workaround, unlike the undo dropdown.

```typescript
await trigger.focus();
await page.keyboard.press('Enter');      // open
await page.keyboard.press('ArrowDown');  // navigate
await page.keyboard.press('Enter');      // select
await page.keyboard.press('Escape');     // close
```

`Select` also accepts an `onOptionHover(value | null)` callback that fires when
an option is highlighted by mouse or keyboard, and fires with `null` on every
close path (selection, outside click, Escape, Tab, trigger toggle, unmount,
external scroll, window resize). Its consumers are `DmpNewImportDialog` and
`ZeroDatumConfigDialog`, which use it to drive a live placement preview. To test
it, assert on the preview the consumer renders.

`e2e-playwright/select-dropdown.spec.ts` is the worked example for all of the
above.

### Detail panel

| Element | `data-testid` |
|---------|---------------|
| Container | `detail-panel` |
| Station / section views | `station-detail`, `section-detail` |
| Station link (position 0-indexed) | `station-{sectionId}-{position}-link` |
| Shot link (position 1-indexed) | `shot-{sectionId}-{position}-link` |
| Section link | `section-{sectionId}-link` |
| Center buttons | `center-station-button`, `center-shot-button`, `center-section-button` |

Links and center buttons carry descriptive `aria-label`s
(`"Select station 2:5"`, `"Center map on station 2:5"`). Links to missing
targets get `aria-disabled="true"` plus a warning indicator and do not change
selection when clicked.

```typescript
await page.click('[data-testid="station-2-5-link"]');
await expect(page.getByTestId('station-detail')).toBeVisible();

const missing = page.getByTestId('station-2-99-link');
await expect(missing).toHaveAttribute('aria-disabled', 'true');
```

**Centering tests must first pan the map off-target**, otherwise they pass or
fail on the initial view:

```typescript
await page.evaluate(() => {
  const map = (window as any).__stalagmight_map__;
  const c = map.getCenter();
  map.setCenter([c.lng + 0.001, c.lat + 0.001]);
});
await waitForMapIdle(page);

await page.click('[data-testid="center-station-button"]');
await waitForMapIdle(page);
const center = await page.evaluate(() => (window as any).__stalagmight_map__?.getCenter());
```

Same shape under WebdriverIO, with `browser.execute(...)` and
`$('[data-testid="center-station-button"]').click()`.

`page.hover()` is reliable for Select options. Where it is not, dispatch a
bubbling `mouseover` instead - see `triggerMouseHover` in
`e2e-playwright/detail-link-hover.spec.ts:272`.

### ARIA live region

Selection changes triggered by detail-panel hyperlinks and data-table shot
selection are announced through a single live region at the App root, always
mounted, visually hidden with `sr-only`, `id="selection-announcer"`,
`role="status"`, `aria-live="polite"`, `aria-atomic="true"`. Map clicks do not
announce.

```typescript
// Use the ID. A generic role selector also matches the toast stack's live regions.
const liveRegion = page.locator('#selection-announcer');
await expect(liveRegion).toBeAttached();
await page.click('[data-testid="station-2-5-link"]');
await expect(liveRegion).toHaveText('Selected station 2:5');
```

### Focus management

Dialogs use `useFocusTrap` (`src/hooks/useFocusTrap.ts`) via `DialogWrapper`.

```typescript
// Tab wraps inside the dialog
const dialog = page.getByTestId('new-project-dialog');
const first = dialog.locator('input, button, select, textarea, [tabindex]').first();
const last = dialog.locator('input, button, select, textarea, [tabindex]').last();

await last.focus();
await page.keyboard.press('Tab');
await expect(first).toBeFocused();

await first.focus();
await page.keyboard.press('Shift+Tab');
await expect(last).toBeFocused();
```

Initial focus priority: `[data-autofocus]` > the first enabled `input`,
`textarea` or `select` (hidden, checkbox and radio inputs excluded) >
`[data-primary-action]` > first non-close button > the close X. So a dialog with a text field focuses the
field, and a confirmation dialog focuses its primary action:

```typescript
await page.click('[data-testid="new-project-button"]');
await expect(page.getByTestId('new-project-name-input')).toBeFocused();
```

Focus returns to the triggering element on close:

```typescript
const trigger = page.getByTestId('new-project-button');
await trigger.click();
await page.keyboard.press('Escape');
await expect(page.getByTestId('new-project-dialog')).not.toBeVisible();
await expect(trigger).toBeFocused();
```

With a nested dialog, only the topmost traps focus and only the topmost closes
on Escape - `dialogStack` sets `inert` on the layers beneath.

```typescript
await page.click('[data-testid="reset-category-defaults"]');
await expect(page.getByTestId('reset-confirm-dialog')).toBeVisible();
await page.keyboard.press('Escape');
await expect(page.getByTestId('reset-confirm-dialog')).not.toBeVisible();
await expect(page.getByTestId('settings-dialog')).toBeVisible();
```

### Global View

| Element | `data-testid` |
|---------|---------------|
| Root | `global-view` |
| Map container | `globalview-map` |
| Survey/markers toggle | `view-mode-toggle` |
| Per-system marker | `system-marker-{filePath}` |
| Search input / clear | `globalview-search-input`, `globalview-search-clear` |
| Right-click menu on a project | `project-context-menu` |

State persists to `localStorage`: `globalViewMode` (`'survey'` / `'markers'`)
and `globalViewMapState` (an object with `center` and `zoom`, written on
`moveend`).

```typescript
await page.click('[data-testid="view-mode-toggle"]');
expect(await page.evaluate(() => localStorage.getItem('globalViewMode'))).toBe('markers');

// Multi-select
await page.click('[data-testid="system-marker-system1.stalx"]');
await page.click('[data-testid="system-marker-system2.stalx"]', { modifiers: ['Control'] });
const selected = await page.evaluate(() =>
  (window as any).__E2E_TEST__.globalViewStore.getState().selectedSystemIds);
expect(selected).toHaveLength(2);

// Search filter - non-matching systems are dimmed via a MapLibre layer filter,
// so assert on the layer paint properties, not on DOM visibility.
await page.fill('[data-testid="globalview-search-input"]', 'sistema');
await page.click('[data-testid="globalview-search-clear"]');
await expect(page.getByTestId('globalview-search-input')).toHaveValue('');
```

### Themes

`e2e-playwright/theme.spec.ts` covers three of the ten themes: default dark
(`@smoke`), switching to light through Settings (`@smoke`), and CSS variable
resolution for dark, light and cave. It also covers immediate apply, revert on
cancel, persistence across a dialog reopen, and the station circle colors.

The other seven themes, day/night palette independence, and auto mode following
the OS `prefers-color-scheme` have **no e2e coverage** - no spec references them.

One app fact worth knowing when you add coverage: `kaleido_eink` force-disables
CSS transitions and animations (`src/index.css`), so a spec that waits on a
transition behaves differently under it.

### Keyboard shortcuts overlay

`?` opens `KeyboardShortcutsDialog`. Two rules matter when you touch it: the
category order is defined in `src/utils/shortcutCategories.ts`, so a spec
asserting order reads it from there rather than hardcoding a list.

Shortcut-recorder specs (`e2e-playwright/settings-shortcuts.spec.ts`) target
rows by `shortcut-primary-<action>`. Removing an action means repointing those
at a surviving one, or they time out.

## Rust patterns

Tests live alongside the source in `src-tauri/src/`. Per-test-module
`#[expect]` (never `#[allow]`) is the clippy idiom here - see
[Linting & Format Policy](linting.md).

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_valid_input() {
        let result = function_under_test(create_test_input());
        assert_eq!(result, expected_output);
    }

    #[test]
    fn rejects_an_invalid_input() {
        assert!(function_that_can_fail(invalid_input).is_err());
    }
}
```

Async tests use `#[tokio::test]`.

### In-memory SQLite

```rust
let conn = rusqlite::Connection::open_in_memory()?;
```

Used by the tile cache, the `.plnx` dive-plan store, and the project database
(`src-tauri/src/persistence/sqlite/open.rs`).

### Fixture files

Resolve fixtures from the manifest directory - they are shared with the E2E
tiers and live outside the crate:

```rust
#[test]
fn parses_v5_dmp() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../e2e/fixtures/test_v5.dmp");
    assert!(path.exists(), "Fixture missing: {}", path.display());

    let dmp = parse_dmp(&path).expect("v5 DMP should parse");
    assert_eq!(dmp.version, 5);
    assert!(!dmp.sections.is_empty());
}
```

Because Rust tests read `e2e/fixtures/`, the CI `check` job must keep running on
changes there. Only `e2e/legacy/**` is safe to path-ignore.

### Inducing save failures must be root-safe

The self-hosted CI runner executes tests as **uid 0 with `CAP_DAC_OVERRIDE`**,
so a `chmod 0444` directory does *not* produce `EACCES` and a permissions-based
inducer silently passes. Use uid-independent inducers instead:

- **Generic "cannot save":** point `file_path` at a **missing parent directory**
  so `Database::open(temp)` fails.
- **The permission-denied humanization branch:** squat a **directory at the
  `.stalx.tmp` path** (parent present) so SQLite cannot open it and returns
  "unable to open database file", which `is_permission_denied` in
  `core/loading.rs` classifies as permission denied.

Do not squat the final `.stalx` path: with `path=None` and no open database,
`save_project` swaps in `next_available_project_path` and the save succeeds
under a new name.

The three tests that own this path, all in
`src-tauri/src/commands/command_tests.rs`:
`test_import_sections_persists_deferred_new_project` (success),
`test_import_sections_deferred_save_failure_warns_no_phantom` (a failed save
warns and leaves no phantom recent-projects entry), and
`test_import_sections_deferred_save_permission_denied_humanizes_no_marker_leak`.

### Registering a new mutation entry point

`MUTATION_ENTRYPOINTS` in `src-tauri/src/core/state/tests.rs` is a
hand-maintained tripwire. Any `execute_*` method that bypasses the generic
`execute()` must be added there, or the read-only edit-gate test will not cover
it.

### Telemetry registry

A new command, dialog, or tool needs its event names added to the Rust registry
*and* to the canonical lists in `src/utils/telemetry.ts`. The registry asserts
an exact `EVENT_NAMES.len()` with a self-documenting ledger comment - keep the
ledger updated when you change the count. The `registry_covers_all_*` coverage
tests run **only** under `--features telemetry`. `registry_covers_all_tools`
parses `src/store/uiStore.ts` to diff `ToolType` against the registry, so a
retired tool needs a `RETIRED_TOOLS` entry.

[telemetry.md](telemetry.md) owns this contract in full, including every named
coverage test. Treat it as authoritative if the two ever disagree.

## Export testing

Image export is `src-tauri/src/export/image.rs`. It emits SVG, then rasterizes
to PNG or PDF.

Sizing is **pixel-stable**: world coordinates are meters, and the SVG is scaled
so the longer dimension lands on `TARGET_SIZE = 800` px:

```rust
let scale = TARGET_SIZE / width.max(height);       // image.rs
let px = |pixels: f64| -> f64 { pixels / scale };  // px -> viewBox units
```

Every visual element is authored in pixels and converted through `px()`, so an
element keeps its on-screen size regardless of survey extent. To verify a size
from a generated SVG, multiply the attribute value by `scale` and compare
against the pixel constant. `PADDING_RATIO = 0.05` adds a 5 % margin on each
side, computed from the **larger** extent so the absolute margin is uniform.

The pixel constants are declared together near `TARGET_SIZE` (stroke widths,
junction trim, zero-datum star radii, penetration-label size / halo / offset).
Read them from the source rather than duplicating the numbers here - a stale
copy of that table is worse than no table.

PNG rasterization scales by DPI: `scale = dpi / 72`.

```bash
cargo test --manifest-path src-tauri/Cargo.toml export      # the export module
cargo test --manifest-path src-tauri/Cargo.toml dpi         # the DPI tests
```

`export_png_dimensions_scale_with_dpi` pins linear DPI scaling (72 vs 288, with a
small rounding tolerance) by reading the width and height straight out of the
PNG IHDR chunk; `png_oversized_dpi_errors` and `png_dpi_zero_errors` pin the
rejection paths.

## WebdriverIO (real app)

Quarantined under `e2e/legacy/`, on-demand only. See
[`e2e/legacy/README.md`](../e2e/legacy/README.md) for what still has unique
coverage there (real TML round-trips, real cross-session persistence,
single-write coordination, large-dataset stress) and what is redundant with
Playwright. Prefer adding new UI coverage to `e2e-playwright/`.

Requirements:

- A WebDriver: `tauri-driver` on Linux and Windows (`cargo install tauri-driver`),
  `tauri-wd` on macOS.
- A display, or `xvfb` for headless (`wdio.sh` detects and starts it).
- A debug build: `pnpm tauri build --debug --no-bundle` (`wdio.sh` checks
  freshness and rebuilds).

```
e2e/
├── agent/       # LLM-agent harness (MCP + WDIO) - see docs/agent-harness.md
├── fixtures/    # .dmp/.tml/.tmlu/.stalx test data (Rust tests read these too)
├── lib/         # shared plumbing: env, display detection, fractal generation
└── legacy/      # the quarantined WebdriverIO suite (specs/, helpers/, README.md)
```

`wdio.conf.ts`, key settings:

- Specs: `./e2e/legacy/specs/**/*.spec.ts`.
- `maxInstances` = `min(4, cpu count)`, overridable with `WDIO_MAX_INSTANCES`;
  **forced to 1 on macOS**, where all workers share one `tauri-wd` and would
  otherwise contend on config and data files.
- Ports: `WDIO_BASE_PORT` (default 4444) and `WDIO_BASE_NATIVE_PORT` (default
  base + 1000), plus the worker index.
- 30 s connection-retry timeout, 10 s default `waitforTimeout`.
- Per-worker config/data/cache isolation under a temp directory, auto-cleaned.

Open dialogs through the E2E store, same as in Playwright:

```typescript
await browser.execute(() => {
  (window as any).__E2E_TEST__.uiStore.getState().openDialog('import');
});
```

### Binary path

The runner looks for `$CARGO_TARGET_DIR/debug/stalagmight`, defaulting to
`~/.cargo_build/debug/stalagmight`. If your tree builds elsewhere, set
`CARGO_TARGET_DIR`:

```bash
CARGO_TARGET_DIR=./src-tauri/target xvfb-run -a pnpm test:e2e
CARGO_TARGET_DIR=./src-tauri/target SKIP_BUILD=1 xvfb-run -a pnpm test:e2e
```

## Fixtures

Shared between the Rust tests and the E2E tiers, in `e2e/fixtures/` - see
[`e2e/fixtures/README.md`](../e2e/fixtures/README.md) for the current inventory
and the DMP format notes. Playwright also keeps a small copy of the DMP files
under `e2e-playwright/fixtures/`.

The real Tauri backend parses these for real under WebdriverIO and in the Rust
tests. Playwright's mock does **not** read them - it returns simulated section
data.

When adding one: prefer real device data (anonymized if needed), or synthetic
data for a specific edge case, and record what it is for in the fixtures README.

## Troubleshooting

### Playwright

| Symptom | Check |
|---------|-------|
| A command returns `null`, UI takes the failure path | The command has no case in `mocks/tauri-ipc.ts`. `pnpm exec vitest run src/test/__tests__/mockContract.test.ts` will say so. |
| A panel renders empty while stats show the right count | A reference-keyed memo froze - the mock returned the same project object twice. See the fresh-identity rule above. |
| A new gate disables UI in every spec | The mock never initializes the state the gate reads. Fix the mock, not the gate. |
| Settings tests fail after adding a category | The mock's **two** config objects need the new block; `focus-management.spec.ts` hardcodes the category order. |
| A dropdown closes the instant it opens | Its trigger's scroll container is missing from the `scrollSafe` list. |
| Flake that rotates identity between runs | Load timing. Reproduce with `--repeat-each=5 --workers=1` before treating it as a real bug. |
| "No tests found", exits in ~1 s | `pnpm <script> -- <flags>`. Use `pnpm exec playwright test <flags>`. |

### WebdriverIO

| Symptom | Fix |
|---------|-----|
| "No such file or directory" for the stalagmight binary | Set `CARGO_TARGET_DIR` to where it was built |
| "No display available" | `xvfb-run -a`, or use `./scripts/wdio.sh` (auto-detects) |
| Port 4444 in use | A stale driver. `pkill tauri-driver`, or use `./scripts/wdio.sh` |
| Driver not found | `cargo install tauri-driver` (Linux/Windows), or install `tauri-wd` (macOS) |
| "Application did not load" with "Could not connect to localhost" in the page source | Stale frontend assets embedded in the binary, typically from `SKIP_BUILD=1`. Rebuild with `pnpm tauri build --debug --no-bundle`, or use `./scripts/wdio.sh`, which checks freshness |
| A dialog is not found | It is missing `role="dialog"` - see the testability contract in the [Testing Guide](TESTING.md) |

### Rust

| Symptom | Check |
|---------|-------|
| Passes locally, fails in CI | Run with `--features telemetry` and `TELEMETRY_ENDPOINT` set - a plain run filters the registry-coverage tests out |
| Every test binary aborts at startup on Windows (`0xC0000139`) | Use `./scripts/test.ps1` |
| A permission-based save-failure test passes vacuously in CI | CI runs as root. Use a root-safe inducer (above) |
| Flaky or order-dependent | Shared mutable state between tests |
