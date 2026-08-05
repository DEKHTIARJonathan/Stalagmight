# macOS agent harness: MacSession (Tier 1) + grant-gated OS input (Tier 2)

Status: design accepted, implementation in progress. Tracking issue: #421 (preflight
error-surfacing split out as #422).

## 1. Problem

The agent harness (`e2e/agent/`, see `docs/agent-harness.md`) drives the real app through
`tauri-driver`, which has no macOS support: Tauri's WebDriver stack is Linux
WebKitWebDriver + Windows msedgedriver, and Apple ships no WebDriver endpoint for embedded
WKWebView. On a Mac, `app_start` dies in a misleading 15 s "port did not start listening"
timeout (#422), and every macOS-only behavior (menu accelerators such as Cmd+S, System
Settings deep-links, TCC-dependent flows) can only be tested by a human.

## 2. Key finding: the repo already has a macOS WebDriver route

The legacy WDIO suite (`e2e/legacy/`, `wdio.conf.ts`) runs on macOS today via:

- **`tauri-plugin-webdriver-automation`** - an in-app WebDriver HTTP server, compiled in
  only with `--features e2e` (`src-tauri/Cargo.toml`, feature `e2e`; registered in
  `lib.rs`). Git dependency, branch `fix/resolve-element-refs-in-execute-sync`.
- **`tauri-wd`** - a W3C WebDriver front-end binary that spawns the app and proxies to the
  plugin (installed via cargo; `--port` only, no `--native-port`).
- **`e2e/mac-app-wrapper.mjs`** - launches the real binary, delays the plugin's
  "[webdriver] listening on port" stdout line by 500 ms (window-creation race), and appends
  the app pid to `STALAGMIGHT_TEST_PIDFILE`.

The harness never uses this route; adopting it is the whole of Tier 1.

### Verified constraints that shape the design

1. **Input is synthetic.** The plugin's `/actions` and element clicks are JS
   `dispatchEvent` in the webview: `isTrusted: false`, `MouseEvent` (not `PointerEvent`),
   `KeyboardEvent` for keys. Native menu accelerators (Cmd+S) never fire; the legacy
   helpers already work around unreliable Meta synthesis with `CMD_KEY = 'Control'`
   (`e2e/legacy/helpers/app.ts`).
2. **Screenshots are DOM-only.** The plugin's `/screenshot` serializes
   `document.documentElement` into an SVG `foreignObject` and rasterizes onto a canvas.
   Canvas/WebGL content - the survey map, the center of this app - renders blank. Real
   pixels require OS-level capture (Tier 2).
3. **`delete_session` SIGKILLs the wrapper**, which cannot forward SIGKILL, orphaning the
   app. The wrapper's pidfile is therefore the authoritative teardown handle (the legacy
   suite reaps it in `afterSession`).
4. **Per-session `tauri-wd` is safe from a single main process.** The shared-daemon dance
   in `wdio.conf.ts` (`onPrepare`) works around wdio worker-process fd inheritance
   ("Address already in use"), which does not apply to the single-process MCP server.
5. **`tauri-wd` spawns the app itself** (env chain: session -> tauri-wd -> wrapper ->
   app), so environment isolation is done by passing an explicit `env:` to the `tauri-wd`
   spawn - no `process.env` mutation.
6. **Plugin `execute-async` has a hard 30 s server-side timeout**, and a result object
   containing both `error` and `message` keys is coerced into a script error. Harness eval
   scripts must stay under 30 s and never return that shape as data.
7. **macOS has no headless display.** Every session is headed on the real desktop: focus
   stealing at `app_start`, and occlusion/App Nap throttling are live concerns (probe R5).
8. **`procs.ts` orphan reaping reads `/proc`** and silently no-ops on darwin; needs
   `ps -o comm=` / `ps -o pgid=` arms.
9. **`build.ts` lacks the darwin `-- --features e2e` arm** that `wdio.sh` has, and the E2E
   build stamp does not record the feature - a plugin-less mac binary would pass freshness
   and then hang at session creation with no port line ever printed.

## 3. Tier model

| | Input grade | Pixels | Permissions | Runs unattended |
|---|---|---|---|---|
| Playwright + mock IPC | synthetic DOM | real (Chromium) | none | yes |
| **Tier 1: MacSession** | synthetic DOM, real backend | DOM-only | none | yes |
| **Tier 2: os_* tools** | real (CGEvent, trusted) | real (`screencapture`) | Accessibility + Screen Recording, per-session grant | no (human grants, shares the desktop) |

Findings must be labeled with the tier that produced them: a Tier 1 "pass" on a drag or a
menu shortcut is evidence about DOM handlers, not about real input.

## 4. Tier 1: MacSession

### 4.1 Interface extraction (platform-neutral refactor)

- `e2e/agent/sessionTypes.ts` (new): `SessionState`, `StartOptions`, `StartResult`,
  `BuildMode`, and `AgentSession` - exactly the surface `mcp/server.ts`, `oracles.ts`,
  `framework.ts` and the smokes consume:
  `state` (mutable: `driver_script`'s wedge handler writes `'crashed'`), `browser`,
  `recorder`, `hasRecorder`, `sessionDir`, `profileDataDir`, `exclusive`,
  `findCrashMarkers`, `start`, `stop`, `uptimeMs`, `driverAlive`. It structurally
  satisfies the existing `OracleTarget` and `ScenarioTarget` seams, which stay unchanged.
- `e2e/agent/lib/sessionCore.ts` (new): shared base class - state machine + `exclusive`
  promise-chain mutex, recorder/owner-marker setup, `findCrashMarkers` walk, `uptimeMs`,
  profile bookkeeping, `reapPreviousSessions`, and `start()`'s try/catch ->
  `stop('start-failed')` wrapper. Platform classes implement `startInner` / `stop` /
  `driverAlive`. (Pure subclassing and pure siblings both rejected: the lifecycle diverges
  at nearly every step, but the mutex/state/recorder invariants are behavior-critical and
  identical - duplicating them invites drift.)
- `e2e/agent/lib/sessionShared.ts` (new): `attachBrowser(port, capabilities)` and
  `verifyReadiness(browser)` (app-ready wait, `__E2E_TEST__` hooks check, onboarding
  disable) - called by both platforms.
- `e2e/agent/createSession.ts` (new): factory,
  `STALAGMIGHT_AGENT_PLATFORM ?? process.platform`; darwin -> `MacSession`, linux ->
  `AppSession`, otherwise a fast, specific refusal (the #422 fix - name the platform, the
  missing driver, and the install command instead of a 15 s timeout). Owns the
  undici-pin first-import ordering.
- Swap the hard `new AppSession()` in `mcp/server.ts`, `smoke.ts`, and any of
  `scenarios-smoke.ts` / `session-http-probe.ts` that instantiate it.
- `procs.ts` darwin arms: `pidComm` via `ps -o comm= -p` (basename of the output),
  `pidPgid` via `ps -o pgid= -p`, try/catch to `''` / `0`; unit tests against
  `process.pid`.

### 4.2 MacSession lifecycle (`e2e/agent/sessionMac.ts`)

- **Build**: darwin arm in `build.ts` -
  `pnpm tauri build --debug --no-bundle -- --features e2e` (with `VITE_E2E=1` as today).
  Build stamp bumps to `v: 2` adding `e2eFeature: boolean`; a v1 stamp reads as stale
  (one forced rebuild per machine, preferred over a plugin-less binary passing freshness).
- **Preflight**: `tauri-wd` resolvable on PATH, else fail fast with the install command.
- **Spawn**: per-session `tauri-wd --port <findFreePort(BASE_PORT)>` with an explicit env:
  `{...process.env, ...isolatedEnv(profileRoot), STALAGMIGHT_TEST_HOOKS: '1',
  RUST_BACKTRACE: '1', STALAGMIGHT_BINARY: <debug binary>,
  STALAGMIGHT_TEST_PIDFILE: <sessionDir>/pids}`. stdout/stderr to `tauri-wd.log` in the
  session dir; `recordPid`. `waitForPortListening` as on Linux.
- **Attach**: `platformName: 'mac'`, `'wdio:enforceWebDriverClassic': true`,
  `tauri:options.application = e2e/mac-app-wrapper.mjs`; then shared `verifyReadiness`.
  Port whatever subset of the legacy `before()` element-ref overrides probe R1 shows is
  still needed into `applyMacBrowserWorkarounds(browser)` (sessionShared.ts).
- **StartResult on darwin**: `display: 'aqua'`, `nativePort: 0`, `appPidKnown: true`
  (wrapper records the real app pid). `headed: false` (the default) is coerced to headed
  with a warning and `headedForced: true` - callers get a session, not a lecture.
- **Teardown**: bounded `deleteSession()` -> SIGTERM the `tauri-wd` pid, ~1.5 s, SIGKILL
  -> `reapPidsFromFile` over comm names `['stalagmight', 'tauri-wd']`. The pidfile holds
  the real app pid, making the reap the authoritative kill given constraint 3. Never reap
  comm `node` (too broad); the wrapper exits on child-exit, so killing the app collapses
  any surviving wrapper.
- **Wrapper hardening** (`e2e/mac-app-wrapper.mjs`): an unref'd orphan watch
  (`process.ppid === 1` -> kill child, exit) to cover `tauri-wd` crashing; benefits the
  legacy suite too.

### 4.3 Known-gap handling

- `press_keys` containing `Meta` on darwin returns a `caveat` field ("synthetic-only;
  native accelerators will not fire - use os_keys (Tier 2) or the in-app Control
  binding"). No silent remap: the app may bind both, and silent rewriting corrupts repro
  records.
- `screenshot` on darwin carries `{domOnly: true, note: ...}`; a DOM + map-canvas
  composite (via `__stalagmight_map__.getCanvas().toDataURL()`) only if probe R4 shows the
  canvas is capturable without a renderer change. Tier 2 `os_screenshot` is the real
  answer for pixels.
- `page.ts` module comment documents the 30 s `execute-async` cap and the
  `{error, message}` coercion; audit that no eval script returns that shape as data.

## 5. Tier 2: grant-gated OS input (`e2e/agent/os/`)

Real trusted input and real pixels, for exactly the class Tier 1 structurally cannot
reach: menu accelerators, native dialogs/deep-links, true rendering. Opt-in, headed,
shares the user's desktop; modeled on a proven local pattern for driving real macOS GUIs.

### 5.1 Layout

```
e2e/agent/os/
  helper/            # Rust bin crate "stalagmight-oshelper" (NOT a src-tauri workspace
    Cargo.toml       #   member; excluded from the app's fmt/clippy CI scope like the
    src/main.rs      #   other out-of-app crates - see docs/linting.md)
  helper.ts          # ensureHelperBuilt() (cargo build into CARGO_TARGET_DIR,
                     #   mtime-stamped like build.ts) + runHelper(args) -> JSON stdout
  permissions.ts     # per-server-process grant flag + preflight()
  input.ts           # os_click / os_keys implementation
  screenshot.ts      # window id by pid -> `screencapture -x -l <id>`
  menu.ts            # AX menu-bar driving
```

Helper subcommands (all JSON on stdout): `preflight` (`AXIsProcessTrusted` +
`CGPreflightScreenCaptureAccess`), `click X Y [--right|--double]`, `move X Y`,
`keys <spec>` (CGEvent with real modifier flags - covers Cmd+S), `window-id --pid N`
(`CGWindowListCopyWindowInfo`), `menu --pid N "File>Save"` (AX `AXPress`), `frontmost`.
Crate deps: `core-graphics` (+ `objc2-app-kit` if the AX path needs it). Rust over
compile-on-demand C because Rust is a first-class repo language and the helper becomes
unit-testable; the one-time cargo cold build is amortized by the mtime stamp.

Input discipline learned from prior GUI-driving work on this platform:

- A hover move precedes every press (some toolkits ignore clicks with no prior
  enter/hover); drags interpolate move events; scrolls tick.
- Frontmost check before every action and every capture; at most ONE activate attempt -
  repeatedly stealing focus back from a human is always wrong. `frontmost_ok` rides every
  result; a false value means "discard the evidence", not "investigate the app".
- Coordinates: element rect via `evalInApp` (CSS points) + window content origin via the
  helper (screen points) -> CGEvent screen points. Retina 2x only matters when
  interpreting captured pixels, never when posting events.
- Screen Recording preflight is mandatory: with it denied, `screencapture` still exits 0
  and writes a desktop-wallpaper-only image that downstream analysis would score as real.

### 5.2 MCP surface and gating

Registered only on darwin (a `defineDarwin` wrapper next to `define` in `mcp/server.ts`):

- `os_grant` - flips a per-server-process flag. Deliberately NEVER added to any tool
  allowlist, so invoking it always produces a real harness permission prompt: the human,
  not the model, holds the grant. Valid until the MCP server exits.
- `os_click(x,y | testid)`, `os_keys(spec)` (real modifiers), `os_menu(path)`,
  `os_screenshot(name?)` (`screencapture -x -l <windowid>` - occlusion-immune, real
  pixels).

Every os_* result carries `{frontmost_ok, permissions: {accessibility, screenRecording}}`.
Ungranted or unpreflighted calls fail with instructions, before touching the machine.

### 5.3 Recorder / replay

os_* actions are recorded to `actions.jsonl` like any tool (they mutate app state; repro
reports need them), but `scripts/generate-replay.mjs` emits them as
`(OS-level; not replayable)` comments, extending the existing observation-comment arm.
Trusted-input replay would need TCC grants, a frontmost desktop and pixel determinism -
none portable. When an os_* step is load-bearing for a repro, it is hand-converted to a
Tier 1 equivalent; the comment preserves intent.

## 6. Phased delivery

- **Phase 0 - probes** (throwaway, results recorded below):
  - R1: wdio-over-tauri-wd fidelity without the legacy overrides - `waitForDisplayed`,
    element-origin `action('pointer')` move+click, `executeAsync` round-trip,
    `browser.keys()`, `takeScreenshot()`.
  - R2: harness `mapClick` under synthetic `MouseEvent` (fallback: eval-based
    `PointerEvent` shim - the harness already owns `dispatchMapPointer` + interaction
    verification).
  - R3: confirm orphaned app on `delete_session` and that the wrapper pidfile lands
    before it returns.
  - R4: `__stalagmight_map__.getCanvas().toDataURL()` non-blank?
  - R5: occlusion/App Nap - do waiters slow when the window is fully covered?
- **PR 1** - interface extraction (behavioral no-op on Linux) + procs darwin arms + #422
  fast refusal. Gate: `typecheck:agent`, lib unit tests, Linux `agent:smoke` +
  `agent:mcp:smoke` via the on-demand workflow.
- **PR 2** - MacSession + build arm/stamp v2 + wrapper orphan watch. Gate:
  `pnpm agent:smoke` and `pnpm agent:mcp:smoke` green on macOS (mac-tolerant assertions:
  crash markers under the isolated `HOME/Library/Application Support`, DOM-only
  screenshot), plus a leak check (3 start/stop cycles, no surviving
  `stalagmight`/`tauri-wd` processes).
- **PR 3** - gap hardening (Meta caveat, `domOnly`, page.ts notes) + the
  `docs/agent-harness.md` macOS section + app-tester agent-definition tier labels.
- **PR 4** - Tier 2. Gate is manual at the machine (TCC): grant flow, preflights, a
  testid click toggling real state, Cmd+S firing the real menu accelerator,
  `os_screenshot` showing real map pixels, and the revoked-Screen-Recording path failing
  loudly instead of shipping a wallpaper.

## 7. Risks

1. R1 fails on element-origin pointer actions or element refs through `execute` -> port
   more of the legacy overrides, or shim drags via eval. Probed before the refactor lands.
2. `map_click` rejects synthetic `MouseEvent` -> `PointerEvent` dispatch shim.
3. Occlusion/App Nap throttles waiters -> decide mitigation from R5 data, not
   preemptively.

## 8. Probe results (Phase 0)

To be filled in as probes run.
