# Slate import: photo of handwritten survey notes -> comments on shots

- **Status:** V1 design SETTLED 2026-07-11 (speculative; lives on `design/slate-import`)
- **Tracking issue:** #274
- **Date:** 2026-07-11
- **Note:** `docs/plans/` was removed from master in #229; this doc lives on the branch only.
- **Roadmap anchor:** `docs/SPEC.md` already lists "OCR for Dive Slates: photo import with text recognition" under Version 3.0+. This is the V1 slice of that.

## 1. Motivation

The MNemo records length/azimuth/depth per shot, but **no comments**: the DMP
parser hard-defaults `comment: None` (`src-tauri/src/parsers/dmp.rs:~237`).
Divers carry the comments on a slate or wet-notes: a handwritten table whose
rows mirror the instrument shots, plus a comment/reference column (tie-offs,
line arrows, jumps, silt, restrictions). Today that column is retyped by hand.

Goal: photograph the slate, OCR it locally, review side-by-side, and attach the
comments to the already-imported MNemo shots. "Slate" here means any handwritten
tabular entry arriving as a picture (slate, wet-notes, paper).

## 2. The core design principle: alignment over transcription

The user selects the target section and shot range up front, so we already hold
the ground truth for the slate's numeric columns (length, azimuth, depth) from
the MNemo import. That means:

- Numeric cells do **not** need accurate open transcription. They only need to be
  recognized well enough to **align slate rows to known shots**: an
  order-preserving fuzzy match of each row's numeric signature against the known
  shot list. Even mediocre handwriting OCR aligns reliably against ~25 known
  candidates.
- The only genuinely *new* data is the **comment column**. Errors there are cheap
  because the side-by-side review UI exists precisely to fix them, with the
  image crop right next to the editable cell.
- Numeric disagreement beyond tolerance is **flagged, not imported**. V1 writes
  comments only. (DECIDED 2026-07-11: anchors + flags; instrument data stays
  authoritative. Numeric corrections from the slate are a possible V2, to be
  filed as a follow-up issue if V1 proves out.)

This drops the OCR accuracy bar from "hard research problem" to "feasible with a
small local model plus human review".

## 3. V1 scope

**In:**
- Import one image (PNG/JPEG) from disk via file picker or drag-drop.
- Rectification: auto quad detection pre-places 4 corner handles, user adjusts,
  Rust applies homography (DECIDED 2026-07-11: auto-detect + manual fallback;
  the manual handles remain the authority, auto is best-effort placement).
- Semi-automatic table layout (auto-proposed column/row lines, user-adjustable).
- Per-cell local OCR, Latin characters only.
- Column-mapping affordance (map detected columns to: shot #, length, azimuth,
  depth, comment, ignore).
- Row-to-shot alignment with per-row confidence + numeric-discrepancy flags.
- Side-by-side review dialog (image with cell overlay <-> editable table).
- Junk-row exclusion (extraneous marks/doodles become excludable rows).
- Commit as one undoable batch of shot-comment updates.

**Out (non-goals for V1):**
- CJK or non-Latin scripts (no test data).
- Phone/live capture (future mobile; V1 keeps the entry format-agnostic: image
  bytes in).
- Writing numeric values (length/azimuth/depth) back to shots.
- Multi-page/PDF, GPU inference, persisted column templates, batch import.

## 4. Pipeline phases

Each phase is a pure Rust function over a serializable artifact, so every stage
is golden-testable and debuggable in isolation. The frontend drives the stages
one IPC command at a time (user interaction sits between stages).

| # | Phase | Input -> Output | Notes |
|---|-------|-----------------|-------|
| 0 | Acquisition | file path -> `RawImage` | file dialog / drag-drop; decode via `image` crate (already a dep) |
| 1 | Rectification | `RawImage` + 4 corners -> `RectifiedImage` | auto quad detection proposes the corners (largest high-contrast quadrilateral; best-effort), user drags to correct; then grayscale, contrast normalize, homography warp (`nalgebra`, already a dep), adaptive binarize copy for layout |
| 2 | Layout extraction | `RectifiedImage` -> `TableLayout` | primary: ruled-line detection (slates are gridded tables, confirmed 2026-07-11), Hough/projection on the binarized image; fallback: ink-density projection profiles; row-count prior = number of selected shots; user adjusts, stage re-runs |
| 3 | Cell OCR | `TableLayout` -> `CellGrid` | per-cell recognition (engine behind a trait); each cell: text, confidence |
| 4 | Parse + normalize | `CellGrid` -> typed cells | per-column-type cleanup: digit confusion table (O->0, l/I->1, S->5, B->8), decimal separators, unit strip |
| 5 | Alignment | typed cells + expected shots -> `AlignedRows` | order-preserving DP match (Needleman-Wunsch style with gap penalties) of row numeric signatures vs the known shot list; tolerates extra/missing rows; emits per-row shot binding + discrepancy flags |
| 6 | Review | `AlignedRows` <-> user edits | frontend only; no Rust mutation |
| 7 | Commit | accepted rows -> `execute(Batch[UpdateShot{comment}])` | existing command path: undo, read-only gate, dirty tracking all free |

(Phases 1 and 5 are additions to the original breakdown: rectification split out
of "cleaning" because it is user-interactive, and alignment called out because
it is the linchpin of the whole design.)

## 5. Architecture

### 5.1 Rust module layout (all new, each file well under the 1500-LOC ratchet)

```
src-tauri/src/slate/
  mod.rs         session types, artifact structs (ts-rs exported)
  rectify.rs     grayscale/contrast/binarize + homography warp
  layout.rs      projection profiles, separator/row-band detection
  recognize.rs   CellRecognizer trait + engine impl(s)
  parse.rs       confusion-table normalization, numeric parsing
  align.rs       DP row alignment against expected shots
src-tauri/src/commands/slate.rs   tauri commands (thin wrappers)
```

The OCR engine sits behind a trait:

```rust
trait CellRecognizer {
    fn recognize(&self, cell: &GrayImage) -> RecognizedText; // text + confidence
}
```

so the engine is swappable (TrOCR now; ocrs for printed text, or a platform
recognizer, later) and every non-engine stage tests without model weights.

### 5.2 Session state, not round-tripped pixels

A `SlateSession` (raw + rectified image, layout, cell grid) lives in `AppState`
keyed by session id, mirroring how `adjusted_cache` holds derived data. The
frontend never round-trips pixels; it receives downscaled previews and per-cell
crops as base64 PNGs on demand.

IPC commands (all new, all read-only w.r.t. the project until commit):

```
slate_begin(path, section_id, shot_range)      -> session_id + preview
                                                  + proposed corner quad
slate_rectify(session_id, corners)             -> rectified preview
slate_layout(session_id, separators?, bands?)  -> proposed/updated TableLayout
slate_recognize(session_id, column_mapping)    -> CellGrid (text + confidence)
slate_align(session_id)                        -> AlignedRows (+ discrepancies)
slate_cell_crop(session_id, row, col)          -> base64 PNG crop
slate_close(session_id)                        -> drop session
```

Commit reuses the **existing** `execute` with `Command::Batch` of
`UpdateShot { comment }` (`core/command.rs`); no new mutation command, so undo
(single step), the read-only edit gate, and dirty tracking come for free.

### 5.3 Frontend

One new dialog (`SlateImportDialog`), three back-navigable steps. Entry point
(DECIDED 2026-07-11): an "Import slate photo..." action in Survey mode opening
the dialog with a section dropdown + shot-range picker, defaulting to the whole
section; the range doubles as the row-count prior for layout and alignment.
Selection-driven entry ("import slate for selected shots") can layer on later.

1. **Rectify:** image viewer + corner handles pre-placed by auto quad
   detection, draggable to correct -> "Straighten".
2. **Layout + mapping:** rectified image with draggable column separators and
   row bands; header dropdowns above each column = the "set expected headers"
   affordance (shot #, length, azimuth, depth, comment, ignore); defaults to
   the common slate order. -> "Recognize" (progress bar; seconds, see 6.3).
3. **Review:** side-by-side. Left: rectified image with cell-boundary overlay,
   hover/selection synced with the table. Right: editable grid (reuse
   `SpreadsheetGrid`, same component as the DataTable) with per-cell confidence
   tinting, per-row shot binding (editable dropdown), numeric-discrepancy
   badges, and an exclude checkbox per row. -> "Apply N comments".

Two-pane dialog precedents already exist (`TmlImportDialog`,
`GpxPlacementDialog`, `ExportDialog`); the image side is a plain `<img>`/canvas
with absolutely-positioned overlays, no new library.

## 6. OCR engine: feasibility and choice

Two-agent research pass, 2026-07-11 (classic HTR engines + small-VLM route).
All options below are fully on-device; C++ deps were in scope per the maintainer. Two
structural findings frame the field:

1. **The dedicated-HTR ecosystem is Python-only.** kraken, PyLaia, Calamari,
   Loghi, HTRflow, eScriptorium: no ONNX or C/C++ inference path exists for any
   of them. They are out regardless of quality. (Also: several of their model
   weights are CC-BY-NC; never ship those.)
2. **Line-trained recognizers need per-ROW crops.** TrOCR scores ~4% CER on IAM
   *lines* but ~30% CER on isolated *words* (microsoft/unilm#1653). Cell-sized
   crops are word-like, so any TrOCR-class engine must be fed row crops (or the
   comment cell, which is naturally a line), not tiny numeric cells.

| Option | Handwriting evidence | Model / dep weight | Rust path | License |
|--------|---------------------|--------------------|-----------|---------|
| **PP-OCRv5 mobile rec via `oar-ocr`** | v5 is the first PP-OCR trained on handwriting; ~50-73% raw accuracy on handwritten text | **7.5 MB** ONNX; `ort` under the hood; single-pass CTC (no decode loop, fast per-cell, no line-context dependency) | `oar-ocr` crate **v0.8.0 (2026-07-08, active)**, Apache-2.0 | Apache-2.0 (code + weights) |
| **TrOCR-small/base-handwritten** | best permissive Latin HTR: 4.22%/3.42% CER IAM lines; the ~30% word-CER caveat above | int8 ~63 MB (small) / fp32 246 MB; runtime `ort` (implement decode loop) or `candle` (has TrOCR example, but base/large only + fragile refs/pr weight branches) | `ort` or `candle` | MIT (weights + conversions) |
| PaddleOCR-VL-0.9B (VLM) | specialist OCR VLM; handwriting is its weak axis; whole-table transcription in ONE inference with structure intact; GBNF-constrainable via llama.cpp | ~1 GB; 20-60 s/slate CPU (image encode dominates; per-cell framing is CPU-hostile: 100+ encodes = minutes) | `ort` (ONNX) or `llama-cpp-2` (mtmd) | Apache-2.0 |
| Small generalist VLMs (Qwen3-VL-2B, Florence-2, SmolVLM2, moondream2) | none beats TrOCR on handwriting at <=3B; the VLMs that do are 7B+ (bust the budget) | 0.5-3 GB | llama.cpp / `mistral.rs` / `ort` | Apache-2.0 / MIT |
| Apple Vision | genuinely strong on handwriting (~99% reports on block print) | zero (OS framework) | `objc2-vision` or Swift CLI bridge | macOS-only: optional accelerator, never the baseline (not all maintainers have Macs; Linux has no equivalent) |
| Tesseract 5 | ~45%, "functionally unusable for cursive"; custom handwriting training made it worse | C libs + vcpkg pain on Windows | `leptess` | skip |
| `ocrs` / OnnxTR / PARSeq | printed/synthetic training, no handwriting pedigree | light | native / `ort` | printed-only fallbacks |
| DeepSeek-OCR | GPU-oriented, ~3B, CPU-hostile | ~6.8 GB | - | ruled out |

**DECIDED 2026-07-11 (staged, matching the get-testable-fast goal):**

- **V1 primary: PP-OCRv5 mobile rec via `oar-ocr`.** Ready today, 7.5 MB
  Apache-2.0 model, single-pass CTC that handles isolated numeric cells (no
  line-context dependency), CTC probabilities give a per-cell confidence signal
  for the review-UI tinting, whole slate recognizes in ~1-3 s. Raw ~50-73%
  handwriting accuracy is comfortably enough for the numeric fuzzy-match
  anchors; comment errors land in the review UI by design. At 7.5 MB the model
  could even ship bundled, deferring the download infra.
- **Escalation path (V1.1, behind the same `CellRecognizer` trait): TrOCR
  handwritten via `ort`** fed per-ROW/comment-cell crops, if the real-photo
  eval shows PP-OCRv5's comment-column accuracy is not good enough. int8 small
  is ~63 MB (this is where first-use download starts mattering); a domain
  fine-tune on slate rows is the known lever if stock accuracy disappoints.
- **Later, optional: Apple Vision as a macOS accelerator** behind the trait.
- **Not chosen: the VLM route.** At our size/CPU budget no VLM beats TrOCR on
  handwriting, and PaddleOCR-VL's real advantage (whole-table structure in one
  shot) is redundant here: we must build the deterministic layout pipeline
  anyway for the review overlay, and slates are ruled grids where line
  detection is cheap and reliable. Revisit only if the classic path fails on
  real photos; the trait boundary keeps that door open (a VLM impl would slot
  in at per-row granularity with GBNF digit grammars + logprob confidence).

The decision gate is the real-photo eval (section 7) on the maintainer's 3-5 slate
photos via the debug harness, measured as (a) row-alignment success rate and
(b) comment-column correction effort in the review UI. If PP-OCRv5 aligns rows
reliably and comments are fixable without pain, V1 ships on it alone; otherwise
TrOCR-per-row comes in behind the trait.

Cargo (DECIDED 2026-07-11): gate the engine behind a `slate-ocr` feature while
experimental (same pattern as `telemetry`) so normal builds/CI stay light; the
deterministic stages (rectify/layout/parse/align) build and test everywhere.

**Model distribution (DECIDED 2026-07-11): first-use download.** The installer
stays small; on first slate import the app downloads the model (progress UI +
checksum verification) into the app data dir. Offline-with-no-model degrades to
a clear "model not downloaded yet" message. Bundling can be revisited if field
use (no connectivity at the cave) demands it.

## 7. Testing strategy

- **Unit (always-on, no model):** confusion-table normalization, numeric
  parsing, homography math, and adversarial alignment cases: missing row, extra
  junk row, duplicated row, transposed digits, all-rows-shifted-by-one. The
  alignment DP is the correctness-critical piece; it gets the deep tests.
- **Golden fixtures (always-on):** 2-3 committed **synthetic** slate images
  (programmatically rendered tables, handwriting-style font) with known ground
  truth, driving layout detection + end-to-end-minus-engine goldens.
  Deterministic, public-repo-safe (repo is heading to public AGPL, #226, and
  `lint:private-leaks` gates the tree), no personal photos committed.
- **Engine eval (manual, local):** real slate photos kept out of the repo; an
  env-gated debug dump (`STAL_SLATE_DEBUG` -> stage artifacts to `$TMPDIR`)
  makes the iterate-on-real-photos loop fast, per the established perf-logging
  pattern.
- **E2E (mocked):** dialog flow with mocked `slate_*` IPC handlers; asserts the
  step flow, mapping UI, review edits, and that Apply emits the expected
  `execute_batch` payload (recorded in a `__MOCK_*_CALLS__` array, per
  convention).

## 8. Registration checklist (mechanical, from the codebase scout)

1. Telemetry: `EVENT_NAMES` entries (new commands + `dialog.slate-import` +
   dwell mirror) + count assertion + ledger comment in
   `src-tauri/src/telemetry/registry.rs`; lists in `src/utils/telemetry.ts`.
2. E2E mock handlers for every `slate_*` command in
   `e2e-playwright/mocks/tauri-ipc.ts` (unknown commands false-negative).
3. `pnpm gen:ipc-types` after adding the ts-rs-exported artifact structs.
4. Dialog registration in `src/App.tsx` + `uiStore` dialog id.
5. `pnpm lint:rust-file-size` before pushing (new files start unbaselined).

## 9. Build order (V1 milestones, sized for opus-tier implementers)

Each milestone is independently verifiable and lands as its own PR-sized unit.
The deterministic stages are fully specified above; the engine is isolated
behind the trait so no milestone blocks on ML behavior.

- **M1 - pipeline core, no engine, no UI.** `slate/` module: rectify (incl.
  auto quad proposal), layout (ruled-line detection + projection fallback),
  parse, align. Synthetic fixture generator + golden tests + the adversarial
  alignment unit tests. Exit: `cargo test` proves image -> aligned rows on
  synthetic slates with a stub recognizer (returns ground truth with injected
  noise - also stress-tests align).
- **M2 - engine + eval harness.** `oar-ocr`/PP-OCRv5 behind `CellRecognizer`
  under the `slate-ocr` feature; model download+checksum on first use;
  `STAL_SLATE_DEBUG` stage-artifact dump. Exit: CLI-level run over the maintainer's real
  photos; measure row-alignment rate + comment quality. **This is the
  feature-viability gate - review results with the maintainer before building M3.**
- **M3 - dialog UI.** `SlateImportDialog` 3-step flow + the `slate_*` IPC
  commands + session state + e2e with mocked IPC. Exit: full flow works in the
  dev app against a real photo.
- **M4 - commit + registration sweep.** Apply-as-`Batch[UpdateShot]`, telemetry
  registry + count assertion, mock handlers, `pnpm gen:ipc-types`, file-size
  lint, `/pre-pr`. Exit: comments land on shots, undo works, all gates green.

## 10. Risks

1. **Real-world accuracy** (glare, pencil on wet plastic, gridlines through
   descenders). Mitigated by the alignment design (numeric cells only need to
   beat a ~25-candidate match) and the review UI; but we need real photos early
   to know where we stand. Biggest unknown; drives Q3.
2. **Cell segmentation** (writing crossing gridlines / overflowing cells).
   Mitigated by user-adjustable separators, generous cell padding, and treating
   the comment column as one line per row (TrOCR is a line recognizer).
3. **Model packaging** across macOS/Linux/Windows + NUC CI. Mitigated by the
   `slate-ocr` feature gate and keeping engine tests out of default CI.
4. **Scope creep.** The non-goals list in section 3 is the contract; V1 exists
   to learn whether the feature is useful, not to be complete.

## 11. Decision log (all resolved with the maintainer, 2026-07-11)

- ~~Q1 Engine/runtime~~ DECIDED 2026-07-11 after a two-agent research pass:
  staged - PP-OCRv5 via `oar-ocr` for V1, TrOCR-per-row behind the
  `CellRecognizer` trait as the accuracy escalation, VLM route not chosen
  (section 6). On-device hard requirement met; C++ was acceptable but the
  chosen path is Rust + `ort`.
- **Q2 revisited and CONFIRMED:** first-use download stays even though the V1
  model is only 7.5 MB - build the download+checksum machinery now so the
  ~63 MB TrOCR escalation later is a config change, not new infra.

All eight major decisions are now locked; remaining unknowns (pencil vs marker,
block vs cursive, actual accuracy) resolve empirically via the real-photo eval.
- ~~Q2 Model distribution~~ DECIDED: first-use download (section 6).
- **Q3 Ground truth (PARTLY DECIDED):** slates are ruled/gridded tables; the
  maintainer will supply 3-5 real photos as local (non-committed) dev fixtures. Still to
  learn from the photos: pencil vs marker, block capitals vs cursive.
- ~~Q4 Numeric semantics~~ DECIDED: anchors + discrepancy flags only;
  corrections deferred to a V2 issue.
- ~~Q5 Comment target~~ DECIDED: shot comments, committed as a Batch of
  existing `UpdateShot` commands (section 5.2).
- ~~Q6 Rectification UX~~ DECIDED: auto quad detection pre-places the corner
  handles, manual drag is the authority (sections 3, 5.3).
- ~~Q7 Entry point~~ DECIDED: section dropdown + shot-range picker in the
  dialog, whole section by default (section 5.3).
- ~~Q8 Build shape~~ DECIDED: `slate-ocr` cargo feature while experimental
  (section 6).
