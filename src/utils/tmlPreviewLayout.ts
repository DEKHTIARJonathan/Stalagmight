/**
 * Lay a parsed Ariane file out in ONE frame so the import dialog can draw it
 * before anything is imported (#425).
 *
 * `SectionPreview` already knows how to draw several sections at given
 * offsets - that is what the mNemo wizard's segment view uses - but it speaks
 * `DmpSection`. This module is the adapter plus the layout: it applies the same
 * shot filter and the same placement rules the Rust converter applies
 * (`convert_tml_with_options` / `determine_placement` in
 * `src-tauri/crates/parsers/src/parsers/tml/`), so what the user sees is what
 * the import will build.
 *
 * It is a PREVIEW, deliberately reimplemented rather than fetched:
 *   - it re-runs on every checkbox click, which no IPC round-trip should;
 *   - it draws PLAN geometry only (x/y), so it ignores everything the backend
 *     does about depth, azimuth reference, closures and unit conversion. A
 *     preview shot's `depth_in`/`depth_out` are carried verbatim only because
 *     the `DmpShot` shape has the fields.
 * The one thing it must agree with the backend on is TOPOLOGY - which section
 * hangs off which, and which sections lose their anchor when a section is
 * deselected - because that is the question the dialog is asking the user.
 */
import type { DmpSection, DmpShot, TmlFile, TmlSection, TmlShot } from '../types/commands';
import { importableShots } from './tmlImportStats';

/** One section as the preview needs it: geometry plus where it sits. */
export interface TmlPreviewSection {
  /** Index into `TmlFile.sections` - the same numbering the dialog's rows,
   *  the selection set and the backend's `selected_sections` all use. */
  index: number;
  name: string;
  color: string;
  /** The section's own shots, adapted for `SectionPreview`. */
  section: DmpSection;
  /** Meters east/north of the layout's origin. */
  offsetX: number;
  offsetY: number;
  /** True when this section attaches to nothing that is being imported, so it
   *  sits at the origin rather than where the file put it. */
  reanchored: boolean;
}

export interface TmlPreviewLayout {
  sections: TmlPreviewSection[];
  /** Sections that lost their anchor because the section they hang off is not
   *  selected. The root is NOT one of these - it belongs at the origin. */
  reanchoredCount: number;
}

export interface TmlPreviewOptions {
  includeExcluded: boolean;
  /** Section indices to lay out. `null` means every section. */
  selected: ReadonlySet<number> | null;
}

/**
 * A `DmpShot` carrying an Ariane shot's plan geometry. Ariane records one
 * azimuth per shot, so both legs get it and `circularMeanDegrees` returns it
 * unchanged.
 */
function toPreviewShot(shot: TmlShot): DmpShot {
  return {
    shot_type: 'Standard',
    heading_in: shot.azimuth,
    heading_out: shot.azimuth,
    length: shot.length,
    depth_in: shot.depth_in,
    depth_out: shot.depth,
    pitch_in: 0,
    pitch_out: 0,
    left: shot.left,
    right: shot.right,
    up: shot.up,
    down: shot.down,
    temperature: 0,
    hour: 0,
    minute: 0,
    second: 0,
    marker_index: 0,
  };
}

function toPreviewSection(section: TmlSection, shots: TmlShot[]): DmpSection {
  return {
    version: 0,
    name: section.name,
    direction: 'in',
    date: section.date ?? '',
    shots: shots.map(toPreviewShot),
    content_hash: '',
  };
}

/** Station positions of a section in its OWN frame, station 0 at (0, 0).
 *  Same recurrence as `computeStationsFromDmpShots`, kept here so the layout
 *  does not have to build a DmpSection before it can position anything. */
function localStations(shots: TmlShot[]): Array<{ x: number; y: number }> {
  const stations = [{ x: 0, y: 0 }];
  for (const shot of shots) {
    const prev = stations[stations.length - 1]!;
    const rad = (shot.azimuth * Math.PI) / 180;
    const dx = shot.length * Math.sin(rad);
    const dy = shot.length * Math.cos(rad);
    stations.push({
      x: prev.x + (Number.isFinite(dx) ? dx : 0),
      y: prev.y + (Number.isFinite(dy) ? dy : 0),
    });
  }
  return stations;
}

/**
 * Where each selected section sits relative to the first one.
 *
 * The placement rules, in the backend's order:
 *   1. the ROOT (lowest selected index) sits at the origin;
 *   2. any other section merges its station 0 onto the station its
 *      `start_ariane_id` names - but only if that station belongs to a SELECTED
 *      section, since a deselected one is never created;
 *   3. anything else falls back to the origin, and is reported as re-anchored.
 *
 * Rule 2 can point forwards (a section whose parent is later in the file), so
 * offsets are resolved by repeated relaxation rather than one pass. A cycle -
 * which valid survey data cannot produce - simply leaves the remaining sections
 * at the origin instead of looping.
 */
export function computeTmlPreviewLayout(
  tml: TmlFile,
  { includeExcluded, selected }: TmlPreviewOptions
): TmlPreviewLayout {
  const isSelected = (i: number) => selected === null || selected.has(i);

  // Ariane shot id -> (section index, station index) over the SELECTED sections
  // only, so a deselected parent resolves to nothing. Shot `i` ends at station
  // `i + 1`.
  // Keyed by BIGINT: Ariane ids are i64 and ts-rs types them as `bigint`, so a
  // `Map<number, …>` would silently miss every lookup.
  const idToLoc = new Map<bigint, { section: number; station: number }>();
  const kept: TmlShot[][] = tml.sections.map((section, i) => {
    const shots = importableShots(section, includeExcluded);
    if (isSelected(i)) {
      shots.forEach((shot, si) => idToLoc.set(shot.id, { section: i, station: si + 1 }));
    }
    return shots;
  });

  const rootIndex = selected === null ? 0 : Math.min(...[...selected], Number.POSITIVE_INFINITY);

  const laidOut = tml.sections.flatMap((section, index) => {
    if (!isSelected(index) || kept[index]!.length === 0) return [];
    const shots = kept[index]!;
    // The parent the backend would use: the raw first shot's `from_id`, then
    // the first surviving shot's, for a section whose lead shots were excluded.
    const candidates = [section.start_ariane_id, shots[0]?.from_id].filter(
      (id): id is bigint => typeof id === 'bigint' && id >= 0n
    );
    const parent =
      index === rootIndex
        ? undefined
        : candidates
            .map((id) => idToLoc.get(id))
            .find((loc) => loc !== undefined && loc.section !== index);
    return [
      {
        index,
        name: section.name,
        color: section.color,
        section: toPreviewSection(section, shots),
        stations: localStations(shots),
        parent,
        offsetX: 0,
        offsetY: 0,
        // Root and parentless-by-design sections are not re-anchored; only a
        // section that HAD a parent in the file and lost it is.
        reanchored: index !== rootIndex && parent === undefined && candidates.length > 0,
      },
    ];
  });

  const byIndex = new Map(laidOut.map((entry) => [entry.index, entry]));
  const placed = new Set<number>(
    laidOut.filter((e) => e.parent === undefined).map((e) => e.index)
  );
  // At most one section is resolved per pass in the worst case (a chain), so
  // `laidOut.length` passes always suffice and a cycle terminates.
  for (let pass = 0; pass < laidOut.length && placed.size < laidOut.length; pass++) {
    for (const entry of laidOut) {
      if (placed.has(entry.index) || !entry.parent) continue;
      const parent = byIndex.get(entry.parent.section);
      if (!parent || !placed.has(parent.index)) continue;
      const anchor = parent.stations[entry.parent.station];
      if (!anchor) {
        // The named station is past the parent's end - not reachable from a
        // file the backend parsed, but a preview must not emit NaN offsets.
        placed.add(entry.index);
        continue;
      }
      entry.offsetX = parent.offsetX + anchor.x;
      entry.offsetY = parent.offsetY + anchor.y;
      placed.add(entry.index);
    }
  }

  return {
    sections: laidOut.map(({ index, name, color, section, offsetX, offsetY, reanchored }) => ({
      index,
      name,
      color,
      section,
      offsetX,
      offsetY,
      reanchored,
    })),
    reanchoredCount: laidOut.filter((e) => e.reanchored).length,
  };
}
