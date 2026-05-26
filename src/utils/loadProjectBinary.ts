/**
 * Decoder for the `load_project_full_binary` IPC response.
 *
 * The Rust side serializes `LoadProjectFullResult` with a layout that
 * keeps small/sparse metadata in an msgpack envelope and packs the bulk
 * numeric fields (shot/station per-row data) into typed-array byte
 * buffers. Reconstructing the same JS shape as the legacy `Project` /
 * `Station[]` is cheap because it's pure memory reads — no per-field
 * parser, no string lookups.
 *
 * Performance target: a 75k-shot / 89k-station project decodes in
 * ~150-300 ms (vs ~5 s for JSON.parse + materialization on the same
 * payload as JSON). Wire format documented in
 * src-tauri/src/core/load_binary.rs — keep field orders in sync.
 */
import { invoke } from '@tauri-apps/api/core';
import { decode as msgpackDecode } from '@msgpack/msgpack';
import type { LoadProjectFullResult } from '../types/ipc/LoadProjectFullResult';
import type { Project } from '../types/ipc/Project';
import type { Section } from '../types/ipc/Section';
import type { Shot } from '../types/ipc/Shot';
import type { Station } from '../types/ipc/Station';
import type { StationRef } from '../types/ipc/StationRef';
import type { ClosureRef } from '../types/ipc/ClosureRef';
import type { GpsCoordinates } from '../types/ipc/GpsCoordinates';
import type { LoopClosure } from '../types/ipc/LoopClosure';
import type { StationMerge } from '../types/ipc/StationMerge';
import type { ZeroDatum } from '../types/ipc/ZeroDatum';
import type { ProjectStats } from '../types/ipc/ProjectStats';
import type { ProjectWarning } from '../types/ipc/ProjectWarning';
import type { DisplaySettings } from '../types/ipc/DisplaySettings';
import type { SurveyDirection } from '../types/ipc/SurveyDirection';
import { recordPerfTiming } from './memoryProbe';

/** Wire format version expected from the Rust encoder. */
const EXPECTED_VERSION = 1;
/** f32 fields per shot. Mirror of SHOT_FLOAT_FIELDS in Rust. */
const SHOT_FLOAT_FIELDS = 12;
/** u32 fields per shot. Mirror of SHOT_UINT_FIELDS in Rust. */
const SHOT_UINT_FIELDS = 3;
/** f64 fields per station. */
const STATION_FLOAT_FIELDS = 3;
/** u32 fields per station. */
const STATION_UINT_FIELDS = 2;

/** Shape of the msgpack-decoded envelope. Mirrors `LoadProjectFullBinaryResult`. */
interface BinaryEnvelope {
  version: number;
  loading_id: bigint | number;
  project_header: ProjectHeaderBinary;
  shot_count: number;
  shots_floats: Uint8Array;
  shots_uints: Uint8Array;
  shots_flags: Uint8Array;
  shot_comments: Array<[number, string]>;
  station_count: number;
  stations_floats: Uint8Array;
  stations_uints: Uint8Array;
  stations_flags: Uint8Array;
  station_gps: Array<[number, GpsCoordinates]>;
  station_merged_with: Array<[number, StationRef[]]>;
  station_closures_with: Array<[number, ClosureRef[]]>;
  station_comments: Array<[number, string]>;
  stats: ProjectStats;
  warnings: ProjectWarning[];
  display_settings: DisplaySettings;
  frozen_shots: unknown[];
}

interface ProjectHeaderBinary {
  name: string;
  location: string | null;
  created_at: string;
  modified_at: string;
  file_path: string | null;
  next_section_id: number;
  next_closure_id: bigint | number;
  sections: SectionHeaderBinary[];
  station_merges: StationMerge[];
  zero_datums: ZeroDatum[];
  loop_closures: LoopClosure[];
  section_offsets: Array<[number, [number, number]]>;
  station_offsets: Array<[StationRef, [number, number, number]]>;
  station_comments_map: Array<[StationRef, string]>;
  imported_file_hashes: string[];
  imported_section_hashes: string[];
}

interface SectionHeaderBinary {
  id: number;
  name: string | null;
  surveyor: string | null;
  date: string | null;
  color: string;
  direction: SurveyDirection;
  quality: number;
  shot_offset: number;
  shot_count: number;
  next_shot_id: number;
}

/**
 * Invoke `load_project_full_binary` and decode the response into the same
 * shape `load_project_full` returned. The frontend can swap one call for
 * the other without touching consumers.
 */
export async function loadProjectFullBinary(path: string): Promise<LoadProjectFullResult> {
  const tInvoke = performance.now();
  let raw: ArrayBuffer | Uint8Array | unknown;
  try {
    raw = await invoke<ArrayBuffer>('load_project_full_binary', { path });
  } catch (e) {
    console.error('[loadProjectFullBinary] IPC failed:', e);
    throw e;
  }
  const tInvokeDone = performance.now();
  recordPerfTiming('binary IPC roundtrip', tInvokeDone - tInvoke);

  // Tauri 2 on Linux delivers Raw responses as ArrayBuffer through the
  // URI scheme protocol fast path. Older configurations or platforms might
  // hand back Uint8Array or a JSON-array fallback — handle all three so
  // the load works even if the IPC path changes shape.
  let bytes: Uint8Array;
  if (raw instanceof Uint8Array) {
    bytes = raw;
  } else if (raw instanceof ArrayBuffer) {
    bytes = new Uint8Array(raw);
  } else if (Array.isArray(raw)) {
    // Slow fallback — Tauri's eval-based callback path. Should not happen
    // for `load_project_full_binary` on Linux/Windows but keep the
    // conversion correct in case the platform changes.
    bytes = new Uint8Array(raw as number[]);
  } else {
    throw new Error(`load_project_full_binary returned unexpected type: ${typeof raw}`);
  }

  const tDecodeStart = performance.now();
  const envelope = msgpackDecode(bytes) as BinaryEnvelope;
  const tDecodeDone = performance.now();
  recordPerfTiming('msgpack decode', tDecodeDone - tDecodeStart);

  if (envelope.version !== EXPECTED_VERSION) {
    throw new Error(
      `load_project_full_binary version mismatch: expected ${EXPECTED_VERSION}, got ${envelope.version}. ` +
      `Rebuild backend or frontend so the binary wire format matches.`
    );
  }

  const tBuildStart = performance.now();
  const result = buildResult(envelope, bytes.byteLength);
  const tBuildDone = performance.now();
  recordPerfTiming('binary->JS materialize', tBuildDone - tBuildStart);

  return result;
}

function buildResult(env: BinaryEnvelope, totalBytes: number): LoadProjectFullResult {
  // Build typed-array views over the bulk byte buffers. These views don't
  // copy; they just point into the underlying ArrayBuffers.
  const shotsF32 = bytesToFloat32(env.shots_floats);
  const shotsU32 = bytesToUint32(env.shots_uints);
  const shotsFlags = env.shots_flags;

  if (shotsF32.length !== env.shot_count * SHOT_FLOAT_FIELDS) {
    throw new Error(`shots_floats length mismatch: ${shotsF32.length} vs ${env.shot_count * SHOT_FLOAT_FIELDS}`);
  }
  if (shotsU32.length !== env.shot_count * SHOT_UINT_FIELDS) {
    throw new Error(`shots_uints length mismatch: ${shotsU32.length} vs ${env.shot_count * SHOT_UINT_FIELDS}`);
  }
  if (shotsFlags.length !== env.shot_count) {
    throw new Error(`shots_flags length mismatch: ${shotsFlags.length} vs ${env.shot_count}`);
  }

  // Index shot comments by global shot index for O(1) lookup.
  const shotCommentByIdx = new Map<number, string>();
  for (const [idx, c] of env.shot_comments) shotCommentByIdx.set(idx, c);

  // Materialize Section[] with embedded Shot[]. Sections are laid out
  // contiguously in `shots_*` so each section reads its slice by offset.
  const sections: Section[] = env.project_header.sections.map((sh) => {
    const shots: Shot[] = new Array(sh.shot_count);
    for (let j = 0; j < sh.shot_count; j++) {
      const globalIdx = sh.shot_offset + j;
      const fBase = globalIdx * SHOT_FLOAT_FIELDS;
      const uBase = globalIdx * SHOT_UINT_FIELDS;
      const azimuth_in = shotsF32[fBase]!;
      const azimuth_out = shotsF32[fBase + 1]!;
      const length = shotsF32[fBase + 2]!;
      const depth_in = shotsF32[fBase + 3]!;
      const depth_out = shotsF32[fBase + 4]!;
      const pitch_in = nanToNull(shotsF32[fBase + 5]!);
      const pitch_out = nanToNull(shotsF32[fBase + 6]!);
      const left = nanToNull(shotsF32[fBase + 7]!);
      const right = nanToNull(shotsF32[fBase + 8]!);
      const up = nanToNull(shotsF32[fBase + 9]!);
      const down = nanToNull(shotsF32[fBase + 10]!);
      const temperature = nanToNull(shotsF32[fBase + 11]!);
      // u32: section_id [uBase], shot_id [uBase+1], marker_or_max [uBase+2].
      const shot_id = shotsU32[uBase + 1]!;
      const markerRaw = shotsU32[uBase + 2]!;
      const marker_index = markerRaw === 0xFFFFFFFF ? null : markerRaw;
      const is_reference = (shotsFlags[globalIdx]! & 1) !== 0;
      const comment = shotCommentByIdx.get(globalIdx) ?? null;
      shots[j] = {
        id: shot_id,
        azimuth_in,
        azimuth_out,
        length,
        depth_in,
        depth_out,
        pitch_in,
        pitch_out,
        left,
        right,
        up,
        down,
        comment,
        is_reference,
        marker_index,
        temperature,
      };
    }
    return {
      id: sh.id,
      name: sh.name,
      surveyor: sh.surveyor,
      date: sh.date,
      color: sh.color,
      direction: sh.direction,
      quality: sh.quality,
      shots,
      next_shot_id: sh.next_shot_id,
    };
  });

  // Reconstruct the section_offsets record: Vec<(SectionId, (f64,f64))> -> Record<number, [number, number]>
  const section_offsets: Record<number, [number, number]> = {};
  for (const [sid, [x, y]] of env.project_header.section_offsets) {
    section_offsets[sid] = [x, y];
  }

  // Note: station_offsets and station_comments_map are on Project but TS
  // type generator skips them (#[ts(skip)]). They're carried in the
  // binary but we don't surface them on the LoadProjectFullResult.project
  // here because the existing JSON path doesn't either.

  const project: Project = {
    name: env.project_header.name,
    location: env.project_header.location,
    created_at: env.project_header.created_at,
    modified_at: env.project_header.modified_at,
    sections,
    station_merges: env.project_header.station_merges,
    zero_datums: env.project_header.zero_datums,
    loop_closures: env.project_header.loop_closures,
    file_path: env.project_header.file_path,
    next_section_id: env.project_header.next_section_id,
    section_offsets,
    imported_file_hashes: env.project_header.imported_file_hashes,
    imported_section_hashes: env.project_header.imported_section_hashes,
    next_closure_id: BigInt(env.project_header.next_closure_id as unknown as number | bigint),
  };

  // Stations: typed-array views over the binary buffers.
  const stationsF64 = bytesToFloat64(env.stations_floats);
  const stationsU32 = bytesToUint32(env.stations_uints);
  const stationsFlags = env.stations_flags;

  if (stationsF64.length !== env.station_count * STATION_FLOAT_FIELDS) {
    throw new Error(`stations_floats length mismatch: ${stationsF64.length} vs ${env.station_count * STATION_FLOAT_FIELDS}`);
  }
  if (stationsU32.length !== env.station_count * STATION_UINT_FIELDS) {
    throw new Error(`stations_uints length mismatch: ${stationsU32.length} vs ${env.station_count * STATION_UINT_FIELDS}`);
  }

  // Index sparse extras by station index for O(1) lookup.
  const gpsByIdx = new Map<number, GpsCoordinates>();
  for (const [i, g] of env.station_gps) gpsByIdx.set(i, g);
  const mergedByIdx = new Map<number, StationRef[]>();
  for (const [i, m] of env.station_merged_with) mergedByIdx.set(i, m);
  const closuresByIdx = new Map<number, ClosureRef[]>();
  for (const [i, c] of env.station_closures_with) closuresByIdx.set(i, c);
  const commentByIdx = new Map<number, string>();
  for (const [i, c] of env.station_comments) commentByIdx.set(i, c);

  const stations: Station[] = new Array(env.station_count);
  for (let i = 0; i < env.station_count; i++) {
    const fBase = i * STATION_FLOAT_FIELDS;
    const uBase = i * STATION_UINT_FIELDS;
    const station: Station = {
      station_ref: {
        section_id: stationsU32[uBase]!,
        station_index: stationsU32[uBase + 1]!,
      },
      coordinates: {
        x: stationsF64[fBase]!,
        y: stationsF64[fBase + 1]!,
        z: stationsF64[fBase + 2]!,
      },
      is_zero_datum: (stationsFlags[i]! & 1) !== 0,
      gps_coordinates: gpsByIdx.get(i) ?? null,
      merged_with: mergedByIdx.get(i) ?? [],
      closures_with: closuresByIdx.get(i) ?? [],
    };
    const cmt = commentByIdx.get(i);
    if (cmt !== undefined) station.comment = cmt;
    stations[i] = station;
  }

  // For visibility in the perf panel, also record the wire size.
  recordPerfTiming('binary payload size (KB)', totalBytes / 1024);

  return {
    loadingId: typeof env.loading_id === 'bigint' ? env.loading_id : BigInt(env.loading_id),
    project,
    stations,
    stats: env.stats,
    warnings: env.warnings,
    displaySettings: env.display_settings,
  };
}

/** Convert a flat byte buffer to a Float32Array view. Aligns the buffer
 *  if needed (msgpack delivers Uint8Array with arbitrary byteOffset). */
function bytesToFloat32(bytes: Uint8Array): Float32Array {
  if ((bytes.byteOffset & 3) === 0) {
    return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  }
  // Misaligned: copy into a fresh buffer.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Float32Array(copy.buffer, 0, bytes.byteLength / 4);
}

function bytesToFloat64(bytes: Uint8Array): Float64Array {
  if ((bytes.byteOffset & 7) === 0) {
    return new Float64Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 8);
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Float64Array(copy.buffer, 0, bytes.byteLength / 8);
}

function bytesToUint32(bytes: Uint8Array): Uint32Array {
  if ((bytes.byteOffset & 3) === 0) {
    return new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Uint32Array(copy.buffer, 0, bytes.byteLength / 4);
}

function nanToNull(v: number): number | null {
  return Number.isNaN(v) ? null : v;
}
