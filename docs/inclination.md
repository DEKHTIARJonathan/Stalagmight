# Inclination sign convention

One rule: **stored pitch is positive-DOWN.** Positive means the shot descends
and depth increases. It is the same frame `depth_in` / `depth_out` are already
in, which is what makes it the useful choice: a pitch and the depth change
beside it can be compared without either being flipped first.

Every external format we read is the opposite (positive-up). The conversion
happens exactly once per format, at its import boundary, and nowhere else.

Established in [#296](https://github.com/Stalagmight/Stalagmight/issues/296),
which fixed a DMP import that skipped the conversion.

## Where the flip happens

| Source | In-file convention | Where it is normalised |
|---|---|---|
| mNemo DMP | +up (device: `-90` = straight down) | `parse_section` (`src-tauri/src/parsers/dmp.rs`) |
| Walls `.srv` | +up | `walls/srv.rs`, negates `inc_up` into `pitch_in`/`pitch_out` |
| Compass | +up | `compass.rs`, `pitch_in: Some(-inclination)` |
| Ariane `.tml` / `.tmlu` | +up (inferred, see below) | `parsers::tml::inclination_to_pitch`, inverse `export::tml::pitch_to_inclination` |

DMP normalises inside `parse_section`, not at the `ShotData` conversion, because
`DmpShot::to_shot_data` is not on the import path. Real DMP import returns the
parsed `DmpFile` to the frontend (`import_dmp`), and the import dialog builds
`ShotData` in TypeScript and sends it to `import_sections`. Normalising at the
parser is what keeps the preview table, the overlap merge against existing
project shots, and `to_shot_data` in one frame; a conversion that lived only in
`to_shot_data` would never run.

The flip is applied after `compute_section_hash`, which therefore still hashes
the device's own bytes, so re-import deduplication keeps recognising sections
imported by an older build.

`pitch_out` is a foresight in the same sense as `pitch_in`, not a reversed
backsight, which is why both legs are negated identically, why validation may
average them, and why a synthesized reverse leg negates the forward reading
rather than reusing `pitch_out` (`export::tml::reversed_leg_pitch`).

## Consumers

Anything deriving inclination from geometry must use `depth_out - depth_in` so
it lands in the same frame:

- `models::shot::pitch_from_components`: `atan2(dz, horizontal)`, +down
- `core::validation`: compares recorded against implied directly, no negation
- `core::state::command_move`: writes +down pitch when a move reshapes a shot
- `DetailPanel.computeInclination`, `WarningResolution.impliedInclination`,
  `resolutionPreview.lengthFixableFromInclination` (TypeScript)

The UI displays stored pitch **raw**. There is no display-boundary negation, so
what the user sees is what is in the file.

Reversing a shot (swapping its legs) negates pitch. That is true under either
convention and is not a convention conversion, see
`overlapHelpers.reverseTargetShot`.

## Ariane: an inference, not a measurement

Ariane's `<Inclination>` sign could not be established from data. `pytool_ariane_lib`
never computes with the field, and across every Ariane file available all 5,686
shots carry `Inclination` 0, because these are depth-gauge surveys and Ariane
does not populate it. Stalagmight treats it as +up because every format around
it is:
Walls and Compass both store +up in-file, and the mNemo reports +up.

On real files the flip is a no-op, so it only affects what we export. If a
counter-example ever turns up, an Ariane file with a non-zero inclination
alongside a known depth progression, it settles the question, and the two
helpers named in the table above are the only places to change.

## Migrating old projects

Schema v12 normalises pre-#296 files, which mix conventions: DMP-sourced shots
are +up, Walls/Compass-sourced shots already +down. No shot or section records
its importer, so `migrate_pitch_to_down_convention` infers it from geometry.

The verdict is **per section, never per shot**. A single shot is often
ambiguous: near-horizontal and very short shots carry almost no signal (1 cm
depth resolution swamps the implied angle), and on real data individual shots do
score better in the wrong direction. A section is decisive because the
convention is a property of the file it was imported from.

Per-section also protects real data: a shot whose inclination genuinely
contradicts its depths cannot flip itself into agreement. It inherits the
section verdict and stays flagged, which is the entire point of the
`INCLINATION_DEPTH_MISMATCH` check.

A section is only touched when the evidence is lopsided: at least 3 usable
shots, and a flipped error less than half the as-is error. Real DMP sections
clear that by 3-7x and already-correct sections fail it by a wide margin.
Anything in between is left alone rather than guessed at. Out-of-range legs
(steeper than vertical) do not vote: validation skips the cross-check for them,
so a single blunder should not drag a section's verdict. Sections that had
signal but were not decisive are named in a `warn!` on open, because the v12
stamp means they are never re-examined.

### What else the migration has to discard

The migration rewrites the `shots` table. Three other stores keep pitch, or a
verdict derived from it, and none of them is versioned, so a stale copy would
outlive the migration with no second pass to catch it. When at least one section
is flipped, `invalidate_pre_pitch_flip_state` drops all three:

- **Persisted undo/redo.** Payloads carry absolute pitch and whole-project
  snapshots, so one undo of a pre-upgrade edit would write the +up value back
  into a file already stamped v12. `UNDO_FORMAT_SAFE_VERSION` is 7, so a v11
  file keeps its stacks by default.
- **Dismissed inclination warnings.** `resolved_warnings` is keyed by
  `(section_id, shot_id, warning_code)` with no value component, so a mismatch
  dismissed under the old convention would keep suppressing the check.
- **The collab sidecar baseline.** The sibling `.tml` on disk was written by a
  pre-#296 build in the unflipped convention, so diffing against it reports a
  phantom inclination edit of twice the pitch on every shot in a section the
  migration correctly left alone. Clearing the hash and the per-shot baseline
  forces a fresh export before the next reconcile.

A project where nothing was flipped keeps its undo history.

## Adding a new importer

Normalise at the import boundary and say so in a comment naming the source's
convention. Put it in the function the real import path actually calls, which
is not necessarily the one that builds `ShotData`: for DMP the conversion has
to sit in the parser, because the dialog builds `ShotData` in TypeScript.
Do not add a negation to a consumer; if a consumer looks like it needs one, the
import is wrong. That is the bug #296 was.
