# Slate import: photo of handwritten survey notes -> comments on shots

- **Status:** V1 design draft, iterating with Nico (speculative; lives on `design/slate-import`)
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
- Manual-assist rectification (user drags 4 corners; Rust applies homography).
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
- Automatic corner/page detection (manual drag is deterministic and cheap).
- Writing numeric values (length/azimuth/depth) back to shots.
- Multi-page/PDF, GPU inference, persisted column templates, batch import.

## 4. Pipeline phases

Each phase is a pure Rust function over a serializable artifact, so every stage
is golden-testable and debuggable in isolation. The frontend drives the stages
one IPC command at a time (user interaction sits between stages).

| # | Phase | Input -> Output | Notes |
|---|-------|-----------------|-------|
| 0 | Acquisition | file path -> `RawImage` | file dialog / drag-drop; decode via `image` crate (already a dep) |
| 1 | Rectification | `RawImage` + 4 corners -> `RectifiedImage` | grayscale, contrast normalize, homography warp (`nalgebra`, already a dep), adaptive binarize copy for layout |
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

One new dialog (`SlateImportDialog`), three back-navigable steps, opened from
Survey mode with a section selected (entry point per open question Q7):

1. **Rectify:** image viewer + draggable corner handles -> "Straighten".
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

Verified 2026-07-11. All options are local; no cloud dependency.

| Option | Handwriting quality | Dep weight | Notes |
|--------|--------------------|-----------|-------|
| **TrOCR-small-handwritten** (IAM-trained transformer) | best available locally | model ~60-80 MB int8 / ~250 MB fp32; runtime = `candle` (pure Rust) or `ort` (ONNX Runtime native lib) | line-level recognizer: perfect fit for per-cell recognition; Latin-only by training, which matches scope; ONNX exports exist (Xenova) and candle ships a TrOCR example |
| `ocrs` (robertknight) | weak (trained on printed/synthetic) | light, pure Rust (RTen) | good printed-text fallback; not the handwriting primary |
| `oar-ocr` / PaddleOCR via ort | printed-oriented | medium | detection model could inspire layout, recognition wrong-domain for handwriting |
| Tesseract | poor on handwriting | C system dep, packaging pain on 3 OSes | not recommended |
| Apple Vision | excellent | zero (OS framework) | macOS-only; violates cross-platform (Daniel has no Mac); optional later accelerator at most |

**Recommendation:** TrOCR-small-handwritten, runtime preference `candle` (pure
Rust, aligns with the repo's portability preference, no native-library
packaging) with `ort` as fallback if candle CPU perf or operator coverage
disappoints. Per-cell inference on M1/typical CPU is ~50-150 ms; a 25-row x
5-column slate is ~125 cells => roughly 6-20 s single-threaded, less with rayon
across cells. Fine for V1 behind a progress bar, and the numeric columns can
move to a lighter digit-specialized path later if needed.

Cargo: gate the engine behind a `slate-ocr` feature while experimental (same
pattern as `telemetry`) so normal builds/CI stay light; the deterministic stages
(rectify/layout/parse/align) build and test everywhere.

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

## 9. Risks

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

## 10. Open questions (deciding with Nico)

- **Q1 Engine/runtime (OPEN, decision escalated 2026-07-11):** on-device is a
  hard requirement; C++ dependencies are acceptable. Expanded engine search in
  progress (classic HTR engines + small-VLM route); section 6 to be rewritten
  with the findings. Everything else in this doc is engine-agnostic behind the
  `CellRecognizer` trait.
- ~~Q2 Model distribution~~ DECIDED: first-use download (section 6).
- **Q3 Ground truth (PARTLY DECIDED):** slates are ruled/gridded tables; Nico
  will supply 3-5 real photos as local (non-committed) dev fixtures. Still to
  learn from the photos: pencil vs marker, block capitals vs cursive.
- ~~Q4 Numeric semantics~~ DECIDED: anchors + discrepancy flags only;
  corrections deferred to a V2 issue.
- **Q5 Comment target:** shot comment (recommended; simplest, `UpdateShot`
  exists) vs station comment vs per-import choice?
- **Q6 Rectification UX:** manual 4-corner drag (recommended) vs auto-detect vs
  require straight-on photos?
- **Q7 Entry point:** pre-select section + shot range then open dialog
  (recommended) vs section-only with alignment finding the range?
- **Q8 Build shape:** `slate-ocr` cargo feature while experimental (recommended)
  vs always-on?
