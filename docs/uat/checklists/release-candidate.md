# Release-candidate UAT checklist

Run per RC tag, per platform, against the BUILT artifact (not a dev server).
Record the outcome as one line in [`../ledger.md`](../ledger.md); on any failure
file an issue and link it from the ledger line. Automated prerequisites first,
then the human items no workflow can do.

## 0. Automated prerequisites (any platform)

- [ ] `pnpm agent:journeys -- --ledger` is green at the RC commit.
- [ ] `pnpm agent:scenarios` is green at the RC commit.
- [ ] The 7 unique-coverage legacy WDIO specs (`e2e/legacy/README.md` lists
      them) have run at the RC commit: `./scripts/wdio.sh`.

## macOS (Apple Silicon)

- [ ] Download the DMG from the draft release (do not use a locally built one).
- [ ] Open the DMG **on a Mac that did not build it** and record which
      Gatekeeper dialog appears. The dismissible "unidentified developer"
      prompt is the expected state; "damaged" is a release blocker
      (docs/releasing.md, "The one macOS check no workflow can do").
- [ ] Verify the app inside the DMG: `./scripts/verify-macos-signature.sh`.
- [ ] Launch, create a project, import a `.tml`, save, quit, relaunch, reopen
      from Recent Projects; the survey renders and counts match.
- [ ] Export an image (PNG) and a `.tml`; both open/parse elsewhere.

## Windows

Transcribed from the #410/#429 hand-driven sweep - these four classes shipped
broken and only a human session caught them:

- [ ] Install from the MSI; note the SmartScreen dialog variant.
- [ ] Save a project to a path with spaces AND to a deep (>200 char) path; a
      failure must surface a Windows-appropriate error, not the macOS
      permissions dialog, and never a silent no-op (#429 item 2).
- [ ] Recent Projects shows full, correctly-formatted Windows paths - drive
      letters intact, cards distinguishable (#429 item 1).
- [ ] Import a Walls `.SRV`/`.WPJ` saved with a UTF-8 BOM; the first directive
      must take effect (#429 item 4).
- [ ] Window resize / maximize / DPI-scale change: layout stays usable, map
      input tracks the cursor (#410).

## Any platform - core flows

- [ ] Undo/redo a burst of edits across a save: no wrong-target edits, history
      walks both ways (the #413 class). `save-reopen-identity` automates only
      DEPTH survival across the reopen - the walk itself is this manual item
      (or the strict `undo-persistence-fuzz` scenario, on request).
- [ ] Force-quit mid-session, relaunch: no data loss beyond the last save, no
      leftover `.stalx.tmp` beside the project.
