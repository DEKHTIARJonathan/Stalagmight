import { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve as pathResolve } from 'node:path';
import { createRequire } from 'node:module';
import type { CommandError } from '../../src/types/ipc/CommandError';
import type { RemoteLinkBits } from '../../src/types/ipc/RemoteLinkBits';
import type { TmlFile } from '../../src/types/ipc/TmlFile';
import type { TmlShot } from '../../src/types/ipc/TmlShot';
import type { MockCommandFamily, MockCommandName, MockIpcContext, MockReply } from './ipc/types';
import { defaultConfig } from '../../src/types/ipc/defaultConfig';
import { compassImportCommands } from './ipc/compassImport';
import { configCommands } from './ipc/config';
import { dmpImportCommands } from './ipc/dmpImport';
import { gasPlanCommands } from './ipc/gasPlan';
import { historyCommands } from './ipc/history';
import { recoveryCommands } from './ipc/recovery';
import { speleodbCommands } from './ipc/speleodb';
import { tileCacheCommands } from './ipc/tileCache';
import { buildMockShot } from './ipc/shots';
import { INERT_COMMANDS } from './ipc/inert';

declare global {
  interface Window {
    /** Installed by this mock; the app's IPC bridge. Also used to emit events. */
    __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
  }
}

// ----------------------------------------------------------------------------
// msgpack UMD bundle loader.
//
// The production frontend hits `load_project_full_binary` and expects a
// msgpack-encoded `BinaryEnvelope` (see src/utils/loadProjectBinary.ts).
// The mock runs inside the browser via `addInitScript` and can't import
// from npm, so before the mock attaches we inject the @msgpack/msgpack
// UMD bundle, which exposes `window.MessagePack.encode`.  The mock
// handler for `load_project_full_binary` builds the same fixture as
// `load_project_full`, repacks it into the binary wire format, and
// encodes it - exercising the real decoder end-to-end with no
// production-code fallbacks.
// ----------------------------------------------------------------------------
let cachedMsgpackUmd: string | null = null;
function loadMsgpackUmd(): string {
  if (cachedMsgpackUmd !== null) return cachedMsgpackUmd;
  const req = createRequire(import.meta.url);
  const cjsPath = req.resolve('@msgpack/msgpack');
  // dist.cjs/index.cjs → ../dist.umd/msgpack.min.js
  const pkgRoot = dirname(dirname(cjsPath));
  const umdPath = pathResolve(pkgRoot, 'dist.umd/msgpack.min.js');
  cachedMsgpackUmd = readFileSync(umdPath, 'utf8');
  return cachedMsgpackUmd;
}

/**
 * Mock data types matching the Stalagmight Rust backend models.
 */
interface MockProject {
  id: string;
  name: string;
  sections: MockSection[];
  station_merges: unknown[];
  zero_datums: unknown[];
  section_offsets: Record<string, [number, number]>;
}

interface MockSection {
  id: string;
  name: string;
  surveyor: string;
  date: string;
  color: string;
  shots: MockShot[];
}

interface MockShot {
  id: number;
  azimuth: number;
  length: number;
  depth: number;
  left?: number;
  right?: number;
  up?: number;
  down?: number;
  pitch_in?: number;
  pitch_out?: number;
  comment?: string;
}

/**
 * Create a mock project with optional custom data.
 */
function createMockProject(overrides?: Partial<MockProject>): MockProject {
  return {
    id: 'mock-project-001',
    name: 'Test Project',
    sections: [],
    station_merges: [],
    zero_datums: [],
    section_offsets: {},
    ...overrides,
  };
}

/**
 * Create a mock section with optional custom data.
 */
function createMockSection(overrides?: Partial<MockSection>): MockSection {
  return {
    id: 'mock-section-001',
    name: 'Test Section',
    surveyor: 'Test Surveyor',
    date: new Date().toISOString().split('T')[0] ?? '',
    color: '#3b82f6',
    shots: [],
    ...overrides,
  };
}

/** The command families split out of this mock (#576 E8); see ./ipc/types.ts. */
const MOCK_COMMAND_FAMILIES: MockCommandFamily[] = [
  gasPlanCommands,
  dmpImportCommands,
  configCommands,
  tileCacheCommands,
  speleodbCommands,
  compassImportCommands,
  historyCommands,
  recoveryCommands,
];

/**
 * Set up Tauri IPC mocks before the page loads.
 * This intercepts all Tauri API calls and returns mock data.
 */
/** 1x1 transparent PNG, enough for MapLibre to treat a tile as loaded. */
const STUB_TILE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

export async function setupTauriMocks(page: Page): Promise<void> {
  // Serve the custom tile protocol. In the real app Tauri registers
  // `stalagmight-tiles` and answers these; a plain browser has no such handler,
  // so every tile 404s through CORS and floods the console. That was invisible
  // while satellite defaulted off - now that it ships on, the map requests tiles
  // in every spec, and the ones asserting a clean console would fail on noise
  // that says nothing about the app.
  await page.route(/stalagmight-tiles(\.localhost)?/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'image/png',
      headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'max-age=86400' },
      body: STUB_TILE_PNG,
    }),
  );

  // Note on external hosts (#417): the frontend never fetches the live esri
  // host in this env - tileConfig always emits the stalagmight-tiles protocol
  // stubbed above (the mock's arcgisonline url_template has no fetching
  // consumer). The #417 local-red/CI-green console noise was the dev-only
  // agent bridge's /__agent/token probe, now gated off under VITE_E2E in
  // main.tsx. The maplibre CSS, once fetched from unpkg.com, is bundled since
  // #576 C12, so the page makes no external fetch at all.

  // Inject the msgpack UMD bundle first so the load_project_full_binary
  // mock can encode its result the same way the real backend does.
  // Exposes `window.MessagePack` synchronously before any app JS runs.
  await page.addInitScript({ content: loadMsgpackUmd() });

  // [#576 NF-W5I-1] The whole Config the real backend answers get_config with is
  // Config::default() under whatever was stored; the config family lays its fixture
  // over this copy of the generated defaults (`mocks/ipc/config.ts`, `wholeConfig`).
  await page.addInitScript({
    content: `window.__MOCK_DEFAULT_CONFIG__ = ${JSON.stringify(defaultConfig)};`,
  });

  const installTauriIpcMock = (
    families: MockCommandFamily[],
    buildShot: typeof buildMockShot,
    inertCommands: Record<string, { reply: unknown; reason: string }>,
  ) => {
    // Event listener registry for mock Tauri events (plugin:event|listen/emit/unlisten)
    // This is defined early so it can be used by both mockHandler and __tauriEventMock
    interface EventListener {
      handler: number; // The callback ID (transformCallback ID)
      event: string;
    }
    const eventListeners = new Map<number, EventListener>();
    let eventListenerId = 0;
    // Callback registry: transformCallback stores callbacks as window[`_${id}`]
    const callbackRegistry = new Map<string, (arg: unknown) => void>();

    // Helper to emit events to all listeners
    const emitEvent = (eventName: string, payload: unknown) => {
      eventListeners.forEach((listener) => {
        if (listener.event === eventName) {
          const callbackId = listener.handler;
          // Callbacks are stored as window[`_${id}`] by transformCallback
          const callbackKey = `_${callbackId}`;
          const callback = (window as unknown as Record<string, unknown>)[callbackKey] as
            | ((arg: unknown) => void)
            | undefined;
          if (callback) {
            callback({ payload });
          } else {
            // Also check our local registry
            const localCallback = callbackRegistry.get(String(callbackId));
            if (localCallback) {
              localCallback({ payload });
            }
          }
        }
      });
    };

    // Store the mock command handler
    const mockHandler = (() => {
      let currentProject: {
        id: number;
        name: string;
        location: string | null;
        created_at: string;
        modified_at: string;
        file_path: string | null;
        sections: unknown[];
        station_merges: unknown[];
        zero_datums: unknown[];
        loop_closures: unknown[];
        section_offsets: Record<string, unknown>;
      } | null = null;
      let projectPath: string | null = null;
      // `BinaryEnvelope::is_remote` (#270): whether the loaded `.stalx` lives in
      // the SpeleoDB cache. The frontend resolves the read-only gate from this
      // SYNCHRONOUSLY at load, so leaving it off the envelope pinned every
      // Playwright load to `projectLinkKind: 'local'`. Local by default (what
      // almost every spec means); flip per-spec with __MOCK_SET_PROJECT_IS_REMOTE__.
      let projectIsRemote = false;
      // #576 D22: the SpeleoDB link bits (`remote_link`) every survey-mutation outcome
      // carries (EditOutcome, SectionCreated, ShotCreated, ReverseOutcome, BatchOutcome,
      // HistoryOutcome, ImportOutcome, IntegrityRepairResult). Deliberately simple: the
      // real backend reads the open project's link row after the command
      // (`AppState::remote_link_bits`, written by `pool::run_mutation`); the mock keeps
      // no link row, so a remote project reports itself un-pushed and not unwound after
      // every successful edit - a no-op edit included - and a local one reports null.
      // A rejection carries none. The command families reach it as `ctx.remoteLink()`.
      const remoteLink = (): RemoteLinkBits | null =>
        projectIsRemote ? { has_unpushed_edits: true, unwound: false } : null;
      // `BinaryEnvelope::newer_schema_version` (#576 B6-D1): the schema version of a
      // loaded `.stalx` a NEWER Stalagmight saved, else null. Like `projectIsRemote`
      // it describes the NEXT binary load (flip per-spec with
      // __MOCK_SET_PROJECT_NEWER_SCHEMA__); `openProjectNewerSchema` is what the open
      // project got, which is what the backend's save refusal keys on - cleared on
      // close and create, as the backend clears `AppState::newer_file_schema`.
      let mockNewerSchema: number | null = null;
      let openProjectNewerSchema: number | null = null;
      // #576 C5: the workspace mode the frontend last reported (`set_workspace_mode`).
      // While it is Plan or Export the backend refuses every guarded survey edit
      // (`WORKSPACE_GUARDED_COMMANDS` below); reset to Survey on every project
      // create, load and close, as the backend does.
      let mockWorkspaceMode: 'survey' | 'plan' | 'export' = 'survey';
      // The IPC commands whose backend handler runs `AppState::guard_mutation` and is
      // NOT on its read-only-workspace allowlist (`update_project_settings`,
      // `set_project_name_for_path` stay editable in every mode). Every one of them
      // rejects with a WORKSPACE_READ_ONLY `CommandError` (#576 C4).
      const WORKSPACE_GUARDED_COMMANDS = new Set([
        'create_section', 'update_section', 'delete_section', 'reverse_section', 'move_section',
        'move_segment', 'execute_batch', 'create_shot', 'update_shot', 'delete_shot', 'set_shot_kind',
        'create_loop_closure', 'remove_loop_closure', 'merge_stations', 'unmerge_stations',
        'unmerge_station_pair', 'set_zero_datum', 'remove_zero_datum', 'set_station_comment',
        'move_comment', 'move_station', 'undo', 'redo', 'undo_to', 'redo_to', 'set_surface_elevation',
        'repair_project_integrity', 'delete_shot_and_split', 'delete_shot_range_split',
        'delete_shot_range_shift', 'delete_last_shot_and_section', 'split_shot_at_distance',
        'create_section_and_merge', 'import_sections', 'execute_tml_import', 'execute_compass_import',
        'execute_walls_import', 'execute_gpx_import', 'resolve_warning', 'unresolve_warning',
      ]);
      // `BinaryEnvelope::speleo_link_unreadable` (#576 B35(b) review): the NEXT binary
      // load reports that the file's SpeleoDB link row could not be read. Flip per-spec
      // with __MOCK_SET_PROJECT_SPELEO_LINK_UNREADABLE__. `openProjectSpeleoLinkUnreadable`
      // is what the open project got: like the backend, every save over that file is
      // refused, and a Save As elsewhere moves the session to a file without the row.
      let mockSpeleoLinkUnreadable = false;
      let openProjectSpeleoLinkUnreadable = false;
      // `BinaryEnvelope::load_repairs` (#576 B35(h)): what the NEXT binary load reset or
      // dropped, per kind. Flip per-spec with __MOCK_SET_LOAD_REPAIRS__; nothing by default.
      let mockLoadRepairs = { shots: 0, section_offsets: 0, station_offsets: 0, gps_points: 0 };
      // `BinaryEnvelope::unreadable_project_settings` (#576 B15): the stored settings the
      // NEXT binary load could not read. None by default; flip per-spec with
      // __MOCK_SET_PROJECT_UNREADABLE_SETTINGS__.
      let mockUnreadableSettings: string[] = [];
      // Window teardown calls, so an exit-guard spec can assert the POSITIVE
      // outcome of an unguarded close instead of only "no dialog appeared".
      let windowDestroyCount = 0;
      let windowCloseCount = 0;
      let sectionCounter = 0;
      // Shot ids are section-encoded, exactly as the backend allocates them:
      // `Section::new` seeds `next_shot_id = section.id * FEATURE_ID_STRIDE` and
      // increments from there (src-tauri/src/models/section.rs). Keeping the mock
      // on flat 1,2,3 ids made `Math.floor(fid / STRIDE)` accidentally correct and
      // hid a whole class of id-decoding bugs from Playwright (#301).
      const MOCK_FEATURE_ID_STRIDE = 100000;
      const mockShotId = (sectionId: number, seq: number): number =>
        sectionId * MOCK_FEATURE_ID_STRIDE + seq;

      // `section_offsets` reaches the mock in TWO shapes: `create_project_full` /
      // `import_sections` / `execute_gpx_import` build the JS `Record<sectionId, [dx, dy]>`,
      // while the binary envelope (`load_project_full_binary`, mirroring
      // `core/load_binary.rs`) and anything injected through `__E2E_MOCKS__.setCurrentProject`
      // carry the backend's `Array<[sectionId, [dx, dy]]>` pairs. The packer reads either
      // through this; nothing in the mock writes an offset (#576 E3: the reverse's anchor
      // compensation is the backend's).
      const sectionOffsetPairs = (offsets: unknown): Array<[number, [number, number]]> => {
        if (Array.isArray(offsets)) {
          return (offsets as Array<[number, [number, number]]>).map(
            ([k, v]) => [Number(k), v] as [number, [number, number]],
          );
        }
        return Object.entries((offsets ?? {}) as Record<string, [number, number]>).map(
          ([k, v]) => [Number(k), v] as [number, [number, number]],
        );
      };

      // The binary envelope `core/load_binary.rs` encodes, packed from the JSON state this
      // mock builds: `load_project_full_binary` packs the `load_project_full` fixture and
      // `get_project_state_binary` (#576 A9-D2) the `get_project_state` answer, so every
      // mocked edit reaches the refresh exactly as it reached the JSON one. Shots and
      // stations go into Uint8Array byte buffers; `extras` carries the load-only fields.
      // Returns an ArrayBuffer, as Tauri delivers the backend's raw `Response` (the
      // decoder's `instanceof ArrayBuffer` branch). The msgpack UMD was injected by the
      // wrapping setupTauriMocks before this script ran, so `window.MessagePack` is there.
      type MockEnvelopeState = {
        project: {
          id?: number; name?: string; location?: string | null;
          created_at?: string; modified_at?: string; file_path?: string | null;
          next_section_id?: number; next_closure_id?: number;
          sections: Array<{
            id: number; name?: string | null; surveyor?: string | null;
            date?: string | null; color?: string; direction?: string; quality?: number;
            // The section's north reference (#438); undefined until an
            // importer declares one.
            azimuth_reference?: unknown | null;
            shots?: Array<{
              id: number; azimuth_in?: number; azimuth_out?: number;
              length?: number; depth_in?: number; depth_out?: number;
              pitch_in?: number | null; pitch_out?: number | null;
              left?: number | null; right?: number | null;
              up?: number | null; down?: number | null;
              temperature?: number | null;
              comment?: string | null;
              kind?: string;
              marker_index?: number | null;
            }>;
          }>;
          station_merges?: unknown[]; zero_datums?: unknown[];
          loop_closures?: unknown[]; section_offsets?: Record<string, [number, number]>;
          // Present once `update_project_settings` has stored per-project
          // thresholds on the mock project (#57).
          validation?: Record<string, number>;
          // Entrance elevation (#431); undefined until an import sets it.
          surface_elevation?: number | null;
          // The project-level north reference (#438); undefined until one
          // is declared.
          default_azimuth_reference?: unknown | null;
        };
        stations: Array<{
          station_ref: { section_id: number; station_index: number };
          coordinates?: { x: number; y: number; z: number };
          is_zero_datum?: boolean;
          gps_coordinates?: unknown | null;
          merged_with?: unknown[];
          closures_with?: unknown[];
          comment?: string | null;
        }>;
        stats: Record<string, unknown> | null;
        frozen_shots?: unknown[];
      };
      const packStateEnvelope = (
        state: MockEnvelopeState,
        extras: {
          loading_id: number; is_remote: boolean; newer_schema_version: number | null;
          speleo_link_unreadable: boolean; unreadable_project_settings: string[];
          load_repairs: Record<string, number>; warnings: unknown[];
          display_settings: Record<string, unknown>;
        },
      ): ArrayBuffer => {
        const totalShots = state.project.sections.reduce(
          (n, s) => n + (s.shots?.length ?? 0),
          0,
        );
        const SHOT_FLOAT_STRIDE = 48;
        const SHOT_UINT_STRIDE = 12;
        const shotsFloats = new Uint8Array(totalShots * SHOT_FLOAT_STRIDE);
        const shotsUints = new Uint8Array(totalShots * SHOT_UINT_STRIDE);
        const shotsFlags = new Uint8Array(totalShots);
        const shotsFloatsView = new DataView(shotsFloats.buffer);
        const shotsUintsView = new DataView(shotsUints.buffer);
        const sectionsMeta: Array<Record<string, unknown>> = [];
        const shotComments: Array<[number, string]> = [];
        let shotCursor = 0;

        for (const section of state.project.sections) {
          const shot_offset = shotCursor;
          const shot_count = section.shots?.length ?? 0;
          for (const shot of section.shots ?? []) {
            const fOff = shotCursor * SHOT_FLOAT_STRIDE;
            const nullToNaN = (v: number | null | undefined): number =>
              v === null || v === undefined ? NaN : v;
            shotsFloatsView.setFloat32(fOff + 0,  shot.azimuth_in ?? 0, true);
            shotsFloatsView.setFloat32(fOff + 4,  shot.azimuth_out ?? 0, true);
            shotsFloatsView.setFloat32(fOff + 8,  shot.length ?? 0, true);
            shotsFloatsView.setFloat32(fOff + 12, shot.depth_in ?? 0, true);
            shotsFloatsView.setFloat32(fOff + 16, shot.depth_out ?? 0, true);
            shotsFloatsView.setFloat32(fOff + 20, nullToNaN(shot.pitch_in), true);
            shotsFloatsView.setFloat32(fOff + 24, nullToNaN(shot.pitch_out), true);
            shotsFloatsView.setFloat32(fOff + 28, nullToNaN(shot.left), true);
            shotsFloatsView.setFloat32(fOff + 32, nullToNaN(shot.right), true);
            shotsFloatsView.setFloat32(fOff + 36, nullToNaN(shot.up), true);
            shotsFloatsView.setFloat32(fOff + 40, nullToNaN(shot.down), true);
            shotsFloatsView.setFloat32(fOff + 44, nullToNaN(shot.temperature), true);
            const uOff = shotCursor * SHOT_UINT_STRIDE;
            shotsUintsView.setUint32(uOff + 0, section.id >>> 0, true);
            shotsUintsView.setUint32(uOff + 4, shot.id >>> 0, true);
            shotsUintsView.setUint32(
              uOff + 8,
              shot.marker_index === null || shot.marker_index === undefined
                ? 0xffffffff
                : shot.marker_index >>> 0,
              true,
            );
            // Binary wire v3: bits 0-1 carry the ShotKind discriminant (#27).
            shotsFlags[shotCursor] =
              shot.kind === 'Jump' ? 1 : shot.kind === 'Reference' ? 2 : 0;
            if (shot.comment) shotComments.push([shotCursor, shot.comment]);
            shotCursor++;
          }
          sectionsMeta.push({
            id: section.id,
            name: section.name ?? null,
            surveyor: section.surveyor ?? null,
            date: section.date ?? null,
            color: section.color ?? '#888888',
            // `SurveyDirection` is "in" | "out", and `In` is the backend's default; the
            // old 'Forward' here was no direction at all, so the section dialogs showed
            // none once the refresh came through this packer (#576 A9-D2).
            direction: section.direction ?? 'in',
            quality: section.quality ?? 1.0,
            shot_offset,
            shot_count,
            // The band this section's shot ids actually live in - a flat
            // cursor here would advertise an id the backend could never mint.
            next_shot_id: mockShotId(section.id as number, shot_count),
            // This section's own north reference (#438); `null` inherits the
            // project default above, which is what a section that declares
            // nothing carries on disk.
            azimuth_reference: section.azimuth_reference ?? null,
          });
        }

        const STATION_FLOAT_STRIDE = 24;
        const STATION_UINT_STRIDE = 8;
        const totalStations = state.stations.length;
        const stationsFloats = new Uint8Array(totalStations * STATION_FLOAT_STRIDE);
        const stationsUints = new Uint8Array(totalStations * STATION_UINT_STRIDE);
        const stationsFlags = new Uint8Array(totalStations);
        const stationsFloatsView = new DataView(stationsFloats.buffer);
        const stationsUintsView = new DataView(stationsUints.buffer);
        const stationGps: Array<[number, unknown]> = [];
        const stationMergedWith: Array<[number, unknown[]]> = [];
        const stationClosuresWith: Array<[number, unknown[]]> = [];
        const stationCommentsArr: Array<[number, string]> = [];

        state.stations.forEach((station, idx) => {
          const fOff = idx * STATION_FLOAT_STRIDE;
          stationsFloatsView.setFloat64(fOff + 0,  station.coordinates?.x ?? 0, true);
          stationsFloatsView.setFloat64(fOff + 8,  station.coordinates?.y ?? 0, true);
          stationsFloatsView.setFloat64(fOff + 16, station.coordinates?.z ?? 0, true);
          const uOff = idx * STATION_UINT_STRIDE;
          stationsUintsView.setUint32(uOff + 0, station.station_ref.section_id >>> 0, true);
          stationsUintsView.setUint32(uOff + 4, station.station_ref.station_index >>> 0, true);
          stationsFlags[idx] = station.is_zero_datum ? 1 : 0;
          if (station.gps_coordinates) stationGps.push([idx, station.gps_coordinates]);
          if (station.merged_with?.length) stationMergedWith.push([idx, station.merged_with]);
          if (station.closures_with?.length) stationClosuresWith.push([idx, station.closures_with]);
          if (station.comment) stationCommentsArr.push([idx, station.comment]);
        });

        const envelope = {
          // Must match `core/load_binary.rs::BINARY_FORMAT_VERSION` and
          // `EXPECTED_VERSION` in `src/utils/loadProjectBinary.ts`; the
          // binaryFormatVersion tripwire pins the other two to each other.
          // Bumped from 3 to 4 when Ariane collaboration mode was removed:
          // the header no longer carries a `collab` field; 4 to 5 for the
          // #438 north references (a project-level default plus one per
          // section header).
          version: 5,
          loading_id: extras.loading_id,
          is_remote: extras.is_remote,
          newer_schema_version: extras.newer_schema_version,
          speleo_link_unreadable: extras.speleo_link_unreadable,
          unreadable_project_settings: extras.unreadable_project_settings,
          load_repairs: extras.load_repairs,
          project_header: {
            name: state.project.name ?? 'Test Project',
            location: state.project.location ?? null,
            created_at: state.project.created_at ?? new Date().toISOString(),
            modified_at: state.project.modified_at ?? new Date().toISOString(),
            file_path: state.project.file_path ?? null,
            next_section_id: state.project.next_section_id
              ?? (sectionsMeta.length + 1),
            next_closure_id: state.project.next_closure_id ?? 1,
            sections: sectionsMeta,
            station_merges: state.project.station_merges ?? [],
            zero_datums: state.project.zero_datums ?? [],
            loop_closures: state.project.loop_closures ?? [],
            section_offsets: sectionOffsetPairs(state.project.section_offsets),
            // The mock has no `station_offsets` state: no mocked command ever
            // writes one, so there is nothing for a reverse to mirror either
            // (the backend's `for_each_station_ref` does mirror them). Give
            // one a home here and `reverse_section` must mirror it too.
            station_offsets: [],
            station_comments_map: [],
            imported_file_hashes: [],
            imported_section_hashes: [],
            // Per-project validation thresholds (#57), sourced like every
            // sibling above: whatever `update_project_settings` last stored
            // on the mock project, else `ValidationConfig::default()` - what
            // a project that never customised its thresholds carries on
            // disk. Rust always sends this; omitting it made every mocked
            // load resolve `project.validation` as `undefined`, which the UI
            // quietly papers over with the GLOBAL config instead
            // (`ShotTableEditor` prefers the project's own thresholds), so
            // per-project thresholds stopped applying with nothing red.
            validation: state.project.validation ?? {
              warn_shot_length_min: 0.3,
              warn_shot_length_max: 50.0,
              warn_depth_change_per_shot_max: 10.0,
              warn_azimuth_deviation_max: 30.0,
              azimuth_diff_threshold: 20.0,
              pitch_diff_threshold: 10.0,
              inclination_depth_diff_threshold: 15.0,
            },
            // Entrance elevation (#431), same provenance as `validation`
            // above: whatever the mock project currently carries, else
            // `null` (unknown) - what a project that never imported one
            // has on disk.
            surface_elevation: state.project.surface_elevation ?? null,
            // The project-level north reference (#438), same provenance as
            // the two above. `null` is "nothing recorded", which is what a
            // project that never declared one carries - and what every
            // section that declares none inherits.
            default_azimuth_reference:
              state.project.default_azimuth_reference ?? null,
          },
          shot_count: totalShots,
          shots_floats: shotsFloats,
          shots_uints: shotsUints,
          shots_flags: shotsFlags,
          shot_comments: shotComments,
          station_count: totalStations,
          stations_floats: stationsFloats,
          stations_uints: stationsUints,
          stations_flags: stationsFlags,
          station_gps: stationGps,
          station_merged_with: stationMergedWith,
          station_closures_with: stationClosuresWith,
          station_comments: stationCommentsArr,
          stats: state.stats,
          warnings: extras.warnings,
          display_settings: extras.display_settings,
          frozen_shots: state.frozen_shots ?? [],
        };

        const MessagePack = (window as unknown as {
          MessagePack?: { encode: (v: unknown) => Uint8Array };
        }).MessagePack;
        if (!MessagePack) {
          throw new Error(
            'binary envelope mock: window.MessagePack missing - setupTauriMocks must inject the msgpack UMD',
          );
        }
        // `slice()` copies exactly the encoded bytes: `encode` may hand back a view into a
        // larger buffer.
        return MessagePack.encode(envelope).slice().buffer;
      };

      // Geometry loading mock control
      // Paths listed here will fail geometry loading (throw error instead of returning data)
      const geometryErrorPaths = new Set<string>();
      // Paths listed here will delay geometry loading (resolve after delay ms)
      const geometryDelayPaths = new Map<string, number>();

      (window as unknown as Record<string, unknown>).__MOCK_SET_GEOMETRY_ERROR__ = (path: string) => {
        geometryErrorPaths.add(path);
      };
      (window as unknown as Record<string, unknown>).__MOCK_CLEAR_GEOMETRY_ERROR__ = (path: string) => {
        geometryErrorPaths.delete(path);
      };
      (window as unknown as Record<string, unknown>).__MOCK_SET_GEOMETRY_DELAY__ = (path: string, delayMs: number) => {
        geometryDelayPaths.set(path, delayMs);
      };
      (window as unknown as Record<string, unknown>).__MOCK_CLEAR_GEOMETRY_DELAY__ = (path: string) => {
        geometryDelayPaths.delete(path);
      };

      // Duplicate import mock state - configurable for hash-tracking tests
      let mockCheckDuplicateResult = false; // Default: no duplicate
      let mergeStationCalls: Array<{
        stationA: { section_id: number; station_index: number };
        stationB: { section_id: number; station_index: number };
      }> = [];
      let unmergeStationPairCalls: Array<{
        stationA: { section_id: number; station_index: number };
        stationB: { section_id: number; station_index: number };
      }> = [];
      let mockOrphanPlacementSuggestions: MockReply<'suggest_orphan_placements'> = [];
      let mockImportPlacementSuggestions: MockReply<'suggest_all_import_placements'> = [];
      // Records execute_walls_import args (esp. selectedSurveys) so the Walls
      // import dialog spec can assert the select-all→null / explicit-index path.
      let wallsImportCalls: Array<Record<string, unknown>> = [];
      // Records execute_tml_import args (includeExcluded, virtualShotMode, …) so
      // the Ariane import spec can assert what the dialog's toggles actually sent.
      let tmlImportCalls: Array<Record<string, unknown>> = [];

      (window as unknown as Record<string, unknown>).__MOCK_SET_CHECK_DUPLICATE_RESULT__ = (result: boolean) => {
        mockCheckDuplicateResult = result;
      };
      (window as unknown as Record<string, unknown>).__MOCK_GET_WALLS_IMPORT_CALLS__ = () => [...wallsImportCalls];
      (window as unknown as Record<string, unknown>).__MOCK_RESET_WALLS_IMPORT_CALLS__ = () => {
        wallsImportCalls = [];
      };
      (window as unknown as Record<string, unknown>).__MOCK_GET_TML_IMPORT_CALLS__ = () => [...tmlImportCalls];
      (window as unknown as Record<string, unknown>).__MOCK_RESET_TML_IMPORT_CALLS__ = () => {
        tmlImportCalls = [];
      };
      // Give the open project a file path (a saved project) so dive-plan save/list is
      // enabled - the bar gates on file_path AND databaseOpen (#275 B3). Call
      // refreshProjectState() after to pick up the file_path change; databaseOpen is
      // set here directly (refreshProjectState doesn't touch it) to mirror what the
      // real app does on load (projectStore.ts:727) and on save success (:1002): a
      // project with a path has an open, saved database. Clearing the path (null)
      // mirrors the unsaved/deferred state.
      (window as unknown as Record<string, unknown>).__MOCK_SET_PROJECT_PATH__ = (
        path: string | null,
      ) => {
        projectPath = path;
        if (currentProject) currentProject.file_path = path;
        (
          window as unknown as {
            __E2E_TEST__?: { projectStore?: { setState: (partial: { databaseOpen: boolean }) => void } };
          }
        ).__E2E_TEST__?.projectStore?.setState({ databaseOpen: path !== null });
      };
      // Make the next binary load report the project as a SpeleoDB-cached copy
      // (or back to local), so a spec can exercise the #270 read-only gate from
      // the load path itself rather than by poking the speleo store afterwards.
      (window as unknown as Record<string, unknown>).__MOCK_SET_PROJECT_IS_REMOTE__ = (
        isRemote: boolean,
      ) => {
        projectIsRemote = isRemote;
      };
      // Make the next binary load report the file as saved by a NEWER Stalagmight
      // (schema `version`), or back to this build's (null) - the #576 B6-D1 read-only
      // state, exercised from the load path itself.
      (window as unknown as Record<string, unknown>).__MOCK_SET_PROJECT_NEWER_SCHEMA__ = (
        version: number | null,
      ) => {
        mockNewerSchema = version;
      };
      // Make the next binary load report an unreadable SpeleoDB link row (or not) -
      // the #576 B35(b) open-time banner, exercised from the load path itself.
      (window as unknown as Record<string, unknown>).__MOCK_SET_PROJECT_SPELEO_LINK_UNREADABLE__ = (
        unreadable: boolean,
      ) => {
        mockSpeleoLinkUnreadable = unreadable;
      };
      // Make the next binary load report stored settings it could not read (#576 B15).
      (window as unknown as Record<string, unknown>).__MOCK_SET_PROJECT_UNREADABLE_SETTINGS__ = (
        keys: string[],
      ) => {
        mockUnreadableSettings = Array.isArray(keys) ? keys : [];
      };
      // Make the next binary load report values it reset or dropped (#576 B35(h)).
      (window as unknown as Record<string, unknown>).__MOCK_SET_LOAD_REPAIRS__ = (repairs: {
        shots?: number;
        section_offsets?: number;
        station_offsets?: number;
        gps_points?: number;
      }) => {
        mockLoadRepairs = { shots: 0, section_offsets: 0, station_offsets: 0, gps_points: 0, ...repairs };
      };
      (window as unknown as Record<string, unknown>).__MOCK_GET_WINDOW_TEARDOWN_COUNTS__ = () => ({
        destroy: windowDestroyCount,
        close: windowCloseCount,
      });
      (window as unknown as Record<string, unknown>).__MOCK_RESET_WINDOW_TEARDOWN_COUNTS__ = () => {
        windowDestroyCount = 0;
        windowCloseCount = 0;
      };
      (window as unknown as Record<string, unknown>).__MOCK_GET_MERGE_STATION_CALLS__ = () => [...mergeStationCalls];
      (window as unknown as Record<string, unknown>).__MOCK_RESET_MERGE_STATION_CALLS__ = () => {
        mergeStationCalls = [];
      };
      (window as unknown as Record<string, unknown>).__MOCK_GET_UNMERGE_STATION_PAIR_CALLS__ = () => [...unmergeStationPairCalls];
      (window as unknown as Record<string, unknown>).__MOCK_RESET_UNMERGE_STATION_PAIR_CALLS__ = () => {
        unmergeStationPairCalls = [];
      };
      // Counts native file-picker opens so a spec can prove the read-only-map guard
      // blocks Import (Ctrl+I) in Plan/Export before the picker even opens (#243).
      // Incremented inside the dialog `open` mock below (same init-script closure).
      let dialogOpenCount = 0;
      (window as unknown as Record<string, unknown>).__MOCK_GET_DIALOG_OPEN_COUNT__ = () => dialogOpenCount;
      (window as unknown as Record<string, unknown>).__MOCK_RESET_DIALOG_OPEN_COUNT__ = () => {
        dialogOpenCount = 0;
      };
      (window as unknown as Record<string, unknown>).__MOCK_SET_ORPHAN_SUGGESTIONS__ = (suggestions: unknown[]) => {
        // shape not checked: spec-seeded suggestions, passed through as given
        mockOrphanPlacementSuggestions = (Array.isArray(suggestions) ? [...suggestions] : []) as MockReply<'suggest_orphan_placements'>;
      };
      (window as unknown as Record<string, unknown>).__MOCK_RESET_ORPHAN_SUGGESTIONS__ = () => {
        mockOrphanPlacementSuggestions = [];
      };
      (window as unknown as Record<string, unknown>).__MOCK_SET_IMPORT_PLACEMENT_SUGGESTIONS__ = (suggestions: unknown[]) => {
        // shape not checked: spec-seeded suggestions, passed through as given
        mockImportPlacementSuggestions = (Array.isArray(suggestions) ? [...suggestions] : []) as MockReply<'suggest_all_import_placements'>;
      };
      (window as unknown as Record<string, unknown>).__MOCK_RESET_IMPORT_PLACEMENT_SUGGESTIONS__ = () => {
        mockImportPlacementSuggestions = [];
      };

      // Station comments set via set_station_comment, keyed
      // "sectionId:stationIndex". get_project_state derives its station array
      // from the project's sections on every refresh, so comments must be
      // threaded back in from here or an edit would vanish on the next refresh.
      const mockStationComments: Record<string, string> = {};

      // Track last export_image call for test assertions
      let lastExportImageArgs: Record<string, unknown> | null = null;

      // Per-path project-name overrides applied by set_project_name_for_path,
      // so list_recent_projects reflects renames within a test; and the paths
      // delete_project removed, which drop out of it as the backend's do.
      const recentNameOverrides: Record<string, string> = {};
      const deletedProjectPaths = new Set<string>();

      // Structural-integrity issues returned by check_project_integrity. Tests
      // seed these via __MOCK_SET_INTEGRITY_ISSUES__; repair fixes all but the
      // trailing `mockIntegrityRemaining` detect-only issues.
      let mockIntegrityIssues: string[] = [];
      let mockIntegrityRemaining = 0;
      // Whether the seeded issues block saving (unresolvable cross-references).
      // Default false so the banner stays dismissable in existing tests.
      let mockIntegritySaveBlocked = false;
      (window as unknown as Record<string, unknown>).__MOCK_SET_INTEGRITY_ISSUES__ = (
        issues: string[]
      ) => {
        mockIntegrityIssues = Array.isArray(issues) ? issues : [];
      };
      (window as unknown as Record<string, unknown>).__MOCK_SET_INTEGRITY_SAVE_BLOCKED__ = (
        blocked: boolean
      ) => {
        mockIntegritySaveBlocked = !!blocked;
      };
      // Seed how many of the issues are detect-only (survive repair), so tests
      // can exercise the "N need manual attention" path.
      (window as unknown as Record<string, unknown>).__MOCK_SET_INTEGRITY_REMAINING__ = (
        n: number
      ) => {
        mockIntegrityRemaining = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
      };

      // [#473] Whether the loaded project's undo/redo history was unreadable and
      // discarded. Default false - every existing spec opens a project whose
      // history loads fine, and a banner appearing over them would be a false
      // failure. Seeded by __MOCK_SET_HISTORY_DISCARDED__.
      let mockHistoryDiscarded = false;
      // How many times the app has ASKED. A spec asserting the banner is absent needs
      // this: `toHaveCount(0)` passes on its first poll, so without a positive signal
      // that the post-load effect has actually run, the assertion is satisfied by the
      // effect not having happened yet and can never fail.
      let mockHistoryDiscardedCalls = 0;
      (window as unknown as Record<string, unknown>).__MOCK_SET_HISTORY_DISCARDED__ = (
        discarded: boolean
      ) => {
        mockHistoryDiscarded = !!discarded;
        mockHistoryDiscardedCalls = 0;
      };
      (window as unknown as Record<string, unknown>).__MOCK_HISTORY_DISCARDED_CALLS__ = () =>
        mockHistoryDiscardedCalls;

      // Expose currentProject setter for E2E tests (allows injecting test fixtures)
      (window as unknown as Record<string, unknown>).__E2E_MOCKS__ = {
        setCurrentProject: (project: typeof currentProject) => {
          currentProject = project;
        },
        getCurrentProject: () => currentProject,
        getLastExportImageArgs: () => lastExportImageArgs,
        clearLastExportImageArgs: () => { lastExportImageArgs = null; },
      };

      // Display settings persistence - in-memory storage for testing reload behavior
      const mockDisplaySettings: Record<string, string> = {
        showStations: 'true',
        showShots: 'true',
        showSectionNames: 'true',
        showDepthGradient: 'false',
      };

      const buildMockGpxFile = (path: string | null | undefined) => {
        const normalized = (path ?? '').toLowerCase();
        const now = new Date();
        const iso = now.toISOString();

        const waypointOnlyFile = {
          name: 'Waypoint Check Dive',
          waypoints: [
            { name: 'Entry Bell', comment: 'Main entry', latitude: 24.55, longitude: -81.78, elevation: 1.2, time: iso },
            { name: 'Jump Reel', comment: null, latitude: 24.5504, longitude: -81.7794, elevation: 3.4, time: iso },
          ],
          tracks: [],
          routes: [],
        };

        if (normalized.includes('waypoints-only')) {
          return waypointOnlyFile;
        }

        return {
          name: 'Reef Traverse',
          waypoints: waypointOnlyFile.waypoints,
          tracks: [
            {
              name: 'Main Line',
              comment: 'Primary track',
              segments: [
                {
                  points: [
                    { latitude: 24.55, longitude: -81.78, elevation: 2.0, time: iso },
                    { latitude: 24.5502, longitude: -81.7798, elevation: 2.6, time: iso },
                    { latitude: 24.55045, longitude: -81.7795, elevation: 3.1, time: iso },
                  ],
                },
              ],
            },
          ],
          routes: [
            {
              name: 'Exit Route',
              comment: null,
              points: [
                { name: 'Route Start', latitude: 24.55045, longitude: -81.7795, elevation: 3.1, time: iso },
                { name: 'Route Mid', latitude: 24.55065, longitude: -81.7792, elevation: 2.8, time: iso },
                { name: 'Route End', latitude: 24.5508, longitude: -81.7789, elevation: 2.5, time: iso },
              ],
            },
          ],
        };
      };

      // Synthetic Ariane TML preview (#411). Fully in-memory - no .tml fixture
      // is read - carrying one of each shot flavour the import dialog's optional
      // controls key off: an excluded shot, a commented shot and a virtual shot.
      const buildMockTmlShot = (
        id: number,
        fromId: number,
        section: string,
        depth: number,
        overrides: Partial<TmlShot> = {}
      ): TmlShot => ({
        id,
        from_id: fromId,
        shot_type: 'Real',
        azimuth: (id * 30) % 360,
        length: 10,
        depth,
        depth_in: depth - 1,
        inclination: 0,
        left: 1,
        right: 1,
        up: 1,
        down: 1,
        comment: null as string | null,
        explorer: 'Synthetic Surveyor',
        date: '2026-01-02',
        color: '#3b82f6',
        excluded: false,
        latitude: 0,
        longitude: 0,
        closure_to_id: 0,
        section,
        ...overrides,
      });

      // A path containing "imperial" yields a file whose unit is Imperial, so a spec can
      // drive the "converted from feet" branch of the dialog. [#576 E3] Canned: the same
      // shots either way. The real parser converts ft->m before it returns the preview and
      // extracts the closures from the Closure rows (`apply_unit_conversion`,
      // `extract_closures`; parsers tml tests `test_imperial_conversion`,
      // `test_closure_mapping`); the closure below is written out, not derived.
      const buildMockTmlFile = (path: string | null | undefined): TmlFile => {
        const imperial = (path ?? '').toLowerCase().includes('imperial');
        const sections: TmlFile['sections'] = [
          {
            name: 'Main Line',
            shots: [
              buildMockTmlShot(1, 0, 'Main Line', 2),
              buildMockTmlShot(2, 1, 'Main Line', 4, { comment: 'Restriction at the T' }),
              buildMockTmlShot(3, 2, 'Main Line', 6, { excluded: true }),
            ],
            surveyor: 'Synthetic Surveyor',
            date: '2026-01-02',
            color: '#3b82f6',
            is_branch_split: false,
            start_ariane_id: 0,
            end_ariane_id: 3,
            start_depth: 0,
          },
          {
            name: 'Side Passage',
            shots: [
              buildMockTmlShot(4, 1, 'Side Passage', 3),
              buildMockTmlShot(5, 4, 'Side Passage', 5, { shot_type: 'Virtual' }),
              // The loop closure, as the real format stores it: a Closure-type
              // ROW near the end of the file. from_id=1 (Main Line station 1)
              // and closure_to_id=4 (Side Passage station 1) keep the previous
              // round's by-construction exclusion-safety: neither endpoint is
              // the excluded shot (id 3, Main Line's terminal) nor preceded by
              // it, so import-space indices agree under BOTH states of the
              // excluded-shots toggle.
              buildMockTmlShot(6, 1, 'Side Passage', 0, {
                shot_type: 'Closure',
                closure_to_id: 4,
                length: 0,
              }),
            ],
            surveyor: 'Synthetic Surveyor',
            date: '2026-01-03',
            color: '#22c55e',
            is_branch_split: true,
            start_ariane_id: 1,
            end_ariane_id: 5,
            start_depth: 2,
          },
        ];
        return {
          cave_name: 'Synthetic Cavern',
          unit: imperial ? 'Imperial' : 'Metric',
          use_magnetic_azimuth: true,
          first_start_absolute_elevation: 0,
          geo_coding: null,
          sections,
          // The Closure row (Side Passage raw row 2) ties back to shot 4 (its raw row 0).
          closures: [{ from_section_index: 1, from_station_index: 2, to_section_index: 1, to_station_index: 0 }],
        };
      };

      // The command families split out of this file (#576 E8, ./ipc/): each owns its
      // commands and the state only they use, and is asked in turn about any command the
      // switch below does not handle.
      const UNHANDLED = {};
      // [#576 E3-D2] Every command no case, family or inert entry answered, in call order.
      // The teardown fixture reads it (and gets each one live through the
      // __E2E_REPORT_UNMOCKED_IPC__ binding, which survives a reload).
      const unhandledCommands: string[] = [];
      (window as unknown as Record<string, unknown>).__MOCK_UNHANDLED_COMMANDS__ = unhandledCommands;
      const familyContext: MockIpcContext = {
        unhandled: UNHANDLED,
        currentProject: () => currentProject,
        invoke: (cmd, args) => mockHandler(cmd, args),
        buildShot,
        remoteLink,
      };
      const familyHandlers = families.map((family) => family(familyContext));

      return function mockCommand(
        name: string,
        args?: Record<string, unknown>
      ): unknown {
        // [#576 E3-D3] Typed as a registered command (or a Tauri plugin bridge call), so a
        // `case` below for a command the backend does not register fails typecheck:playwright.
        const cmd = name as MockCommandName | `plugin:${string}`;
        // Skip logging for push_frontend_log to avoid infinite loop with console capture
        if (cmd !== 'push_frontend_log') {
          console.log(`[Mock IPC] Command: ${cmd}`, args);
        }

        const overrideMap = (window as unknown as Record<string, unknown>).__MOCK_IPC_OVERRIDES__ as
          | Record<string, unknown>
          | undefined;
        if (overrideMap && Object.prototype.hasOwnProperty.call(overrideMap, cmd)) {
          const override = overrideMap[cmd];
          // The two failure forms (#576 C4). `{ __throw: msg }` throws an Error: a
          // transport / JS failure, which the backend never sends as a refusal.
          // `{ __reject: value }` rejects with `value` exactly as given: a backend
          // refusal is `{ __reject: { code, message, ...payload } }` (a `CommandError`;
          // a command whose manifest `error` is `string` rejects with a string).
          // Anything else is the reply itself.
          if (override && typeof override === 'object' && '__throw' in override) {
            throw new Error(String((override as { __throw?: unknown }).__throw ?? 'Mock error'));
          }
          if (override && typeof override === 'object' && '__reject' in override) {
            return Promise.reject((override as { __reject?: unknown }).__reject);
          }
          return override as unknown;
        }

        // #576 C5: the backend's read-only-workspace backstop (guard_mutation).
        if (mockWorkspaceMode !== 'survey' && WORKSPACE_GUARDED_COMMANDS.has(cmd)) {
          const label = mockWorkspaceMode === 'plan' ? 'Plan' : 'Export';
          const message =
            `${cmd} is disabled: the ${label} workspace is ` +
            `read-only. Switch to Survey to edit.`;
          return Promise.reject({ code: 'WORKSPACE_READ_ONLY', message } satisfies CommandError);
        }

        switch (cmd) {
          case 'set_workspace_mode': {
            const mode = args?.mode;
            if (mode !== 'survey' && mode !== 'plan' && mode !== 'export') {
              return Promise.reject(`unknown variant \`${String(mode)}\`, expected one of \`survey\`, \`plan\`, \`export\``);
            }
            mockWorkspaceMode = mode;
            return null satisfies MockReply<'set_workspace_mode'>;
          }

          case 'update_project_settings': {
            // Per-project settings (#57): name + validation thresholds, and the default
            // north reference (#576 NF-W3-2), which the dialog sends on every Save
            // (`null` = nothing recorded).
            if (currentProject) {
              if (typeof args?.name === 'string') currentProject.name = args.name;
              if (args?.validation) {
                (currentProject as Record<string, unknown>).validation = args.validation;
              }
              if (args && 'defaultAzimuthReference' in args) {
                (currentProject as Record<string, unknown>).default_azimuth_reference =
                  args.defaultAzimuthReference ?? null;
              }
            }
            return { warnings: [], remote_link: remoteLink() } satisfies MockReply<'update_project_settings'>;
          }

          case 'set_surface_elevation': {
            // Entrance elevation (#465): set or (given null/undefined) clear.
            // Real command returns a plain EditOutcome (no `project` payload) -
            // the frontend re-fetches via get_project_state's own round trip.
            if (!currentProject) {
              return Promise.reject({ code: 'FAILED', message: 'No project open' } satisfies CommandError);
            }
            // Mirrors the backend's guard_mutation: a remote project without the
            // write lock rejects with the EDIT_DISABLED coded failure. The mock
            // has no held-lock state, so `projectIsRemote` (set via
            // __MOCK_SET_PROJECT_IS_REMOTE__) is the closest read-only proxy -
            // exercised by the elevation read-only-gate spec.
            if (projectIsRemote) {
              return Promise.reject({
                code: 'EDIT_DISABLED',
                message: 'Set entrance elevation is disabled: this SpeleoDB project is open read-only. Acquire the lock to edit.',
              } satisfies CommandError);
            }
            const elevation = args?.elevation;
            if (elevation !== null && elevation !== undefined && typeof elevation !== 'number') {
              return Promise.reject({ code: 'FAILED', message: 'Elevation must be a finite number' } satisfies CommandError);
            }
            if (typeof elevation === 'number' && !Number.isFinite(elevation)) {
              return Promise.reject({ code: 'FAILED', message: 'Elevation must be a finite number' } satisfies CommandError);
            }
            (currentProject as Record<string, unknown>).surface_elevation =
              typeof elevation === 'number' ? elevation : null;
            return { warnings: [], remote_link: remoteLink() } satisfies MockReply<'set_surface_elevation'>;
          }

          case 'create_project_full': {
            // Consolidated create_project_full command for loading progress feature
            const name = (args?.name as string) ?? 'Untitled Project';
            // A project this build created is this build's to save (#576 B6-D1).
            openProjectNewerSchema = null;
            mockWorkspaceMode = 'survey'; // #576 C5: a project opens in Survey
            openProjectSpeleoLinkUnreadable = false;
            const projectLocation = (args?.projectLocation as string | null | undefined) ?? null;
            const savePathArg = (args?.savePath as string | undefined) ?? undefined;
            const saveDirectoryArg = (args?.saveDirectory as string | undefined) ?? undefined;
            const now = new Date().toISOString();
            sectionCounter = 0;
            const sanitizedName = name.replace(/[^a-zA-Z0-9]/g, '_');
            const resolvedPath = savePathArg
              ?? (saveDirectoryArg
                ? `${saveDirectoryArg}/${sanitizedName}.stalx`
                : `/mock/Documents/stalagmight/${sanitizedName}.stalx`);
            projectPath = resolvedPath;

            currentProject = {
              id: 1,
              name,
              location: projectLocation,
              created_at: now,
              modified_at: now,
              file_path: projectPath,
              sections: [],
              station_merges: [],
              zero_datums: [],
              loop_closures: [],
              section_offsets: {},
            };

            // Return CreateProjectFullResult format
            return {
              loadingId: Date.now(),
              // shape not checked: currentProject is the mock's loose project record (sections: unknown[])
              project: currentProject as unknown as MockReply<'create_project_full'>['project'],
              // The backend's DisplaySettings::default() (loading.rs), every field it sends.
              displaySettings: {
                showStations: true,
                showShots: true,
                showSectionNames: true,
                showStationLabels: false,
                showShotData: false,
                showReferenceShots: true,
                showJumps: true,
                showZeroDatum: true,
                showGrid: false,
                // Mirrors the backend's DisplaySettings default (loading.rs);
                // satellite ships on.
                showSatellite: true,
                showDepthGradient: false,
                showStationComments: false,
                showShotComments: false,
                gridSpacing: 10,
                geometryMode: 'measured',
              },
            } satisfies MockReply<'create_project_full'>;
          }

          case 'load_project_full': {
            // Consolidated load_project_full command for loading progress feature
            projectPath = (args?.path as string) ?? null;
            const now = new Date().toISOString();
            sectionCounter = 0;

            // Generate a consistent loadingId for this load operation
            const loadingId = Date.now();

            // Emit progress events (these are received by useLoadingProgress hook)
            // Phase 1: Opening database
            emitEvent('loading-progress', {
              loadingId,
              phase: 'opening_database',
              phaseIndex: 0,
              phaseCount: 8,
              current: null,
              total: null,
              overallPercent: 5,
              isIndeterminate: true,
            });

            // Create a project with sections for testing
            const defaultSections = [
              {
                id: ++sectionCounter,
                name: 'Mock Tunnel A',
                surveyor: 'Test Surveyor',
                date: now.split('T')[0],
                color: '#4ECDC4',
                shots: [
                  { id: mockShotId(sectionCounter, 0), azimuth_in: 45, azimuth_out: 50, length: 10, depth_in: 0, depth_out: -2, kind: 'Normal' },
                  { id: mockShotId(sectionCounter, 1), azimuth_in: 90, azimuth_out: 95, length: 15, depth_in: -2, depth_out: -5, kind: 'Normal' },
                ],
              },
            ];

            currentProject = {
              id: 1,
              name: 'Test Project',
              location: null,
              created_at: now,
              modified_at: now,
              file_path: projectPath,
              sections: defaultSections,
              station_merges: [],
              zero_datums: [],
              loop_closures: [],
              section_offsets: {},
            };

            // Phase 2: Loading project data
            emitEvent('loading-progress', {
              loadingId,
              phase: 'loading_project_data',
              phaseIndex: 1,
              phaseCount: 8,
              current: 1,
              total: 1,
              overallPercent: 20,
              isIndeterminate: false,
            });

            // [#576 E3] The loaded project's stations and stats, canned for the fixed fixture
            // above (one section, id 1, two shots): the placeholder layout at x = 10 i, the
            // absolute station depths 0 / -2 / -5 the shots chain to, and the totals of those
            // two shots. What the backend computes on a real load is pinned by its load tests.
            const mockStations = [0, -2, -5].map((z, i) => ({
              station_ref: { section_id: 1, station_index: i },
              coordinates: { x: i * 10, y: 0, z },
              is_zero_datum: false,
              gps_coordinates: null,
              merged_with: [],
            }));

            // Phase 3-7: Computing stations, validating, etc.
            emitEvent('loading-progress', {
              loadingId,
              phase: 'computing_stations',
              phaseIndex: 3,
              phaseCount: 8,
              current: mockStations.length,
              total: mockStations.length,
              overallPercent: 60,
              isIndeterminate: false,
            });

            // Phase 8: Finalizing
            emitEvent('loading-progress', {
              loadingId,
              phase: 'finalizing',
              phaseIndex: 7,
              phaseCount: 8,
              current: null,
              total: null,
              overallPercent: 95,
              isIndeterminate: true,
            });

            // Return LoadProjectFullResult format
            return {
              loadingId,
              // shape not checked: currentProject is the mock's loose project record (sections: unknown[])
              project: currentProject as unknown as MockReply<'load_project_full'>['project'],
              stations: mockStations,
              stats: {
                section_count: 1,
                shot_count: 2,
                total_length: 25,
                min_depth: -5,
                max_depth: 0,
                station_count: 3,
                loop_count: 0,
                penetration_distance: 25,
              },
              warnings: [],
              // The backend's DisplaySettings::default() (loading.rs), every field it sends.
              displaySettings: {
                showStations: true,
                showShots: true,
                showSectionNames: true,
                showStationLabels: false,
                showShotData: false,
                showReferenceShots: true,
                showJumps: true,
                showZeroDatum: true,
                showGrid: false,
                // Mirrors the backend's DisplaySettings default (loading.rs);
                // satellite ships on.
                showSatellite: true,
                showDepthGradient: false,
                showStationComments: false,
                showShotComments: false,
                gridSpacing: 10,
                geometryMode: 'measured',
              },
              isRemote: projectIsRemote,
              newerSchemaVersion: mockNewerSchema,
            } satisfies MockReply<'load_project_full'>;
          }

          case 'load_project_full_binary': {
            // Mirror the binary IPC wire format that the Rust backend emits from
            // `src-tauri/src/core/load_binary.rs::encode`: the same JSON fixture the legacy
            // `load_project_full` case produces, packed by `packStateEnvelope`.
            const jsonResult = mockHandler('load_project_full', args) as MockEnvelopeState & {
              loadingId: number;
              warnings: unknown[];
              displaySettings: Record<string, unknown>;
            };
            const bytes = packStateEnvelope(jsonResult, {
              loading_id: jsonResult.loadingId,
              // Added to the envelope at v3 alongside the ShotKind bits
              // (`load_binary.rs`): the decoder reads it unvalidated, so omitting
              // it here made every mocked load resolve `isRemote: undefined` and
              // open the SpeleoDB read-only gate. The version tripwire pins the
              // NUMBER, not the field set, so it stayed green.
              is_remote: projectIsRemote,
              // #576 B6-D1: the backend's newer-version verdict for this load.
              newer_schema_version: mockNewerSchema,
              // #576 B35(b) review: the backend could not read this file's link row.
              speleo_link_unreadable: mockSpeleoLinkUnreadable,
              // `BinaryEnvelope::unreadable_project_settings` (#576 B15): none unless a
              // spec seeds __MOCK_SET_PROJECT_UNREADABLE_SETTINGS__.
              unreadable_project_settings: mockUnreadableSettings,
              // `BinaryEnvelope::load_repairs` (#576 B35(h)).
              load_repairs: mockLoadRepairs,
              warnings: jsonResult.warnings,
              display_settings: jsonResult.displaySettings,
            });
            // The backend commits the same verdict as the open project's state.
            openProjectNewerSchema = mockNewerSchema;
            mockWorkspaceMode = 'survey'; // #576 C5: a project opens in Survey
            openProjectSpeleoLinkUnreadable = mockSpeleoLinkUnreadable;
            return bytes satisfies MockReply<'load_project_full_binary'>;
          }

          case 'get_project_state_binary': {
            // [#576 A9-D2] The refresh after an edit: this mock's own `get_project_state`
            // answer (an override of it included) in the load's envelope, with the
            // load-only fields at the no-news values `encode_refresh` sends. No bytes when
            // no project is open, as the backend answers.
            // shape not checked: mockHandler returns unknown; the get_project_state case checks this value
            const state = mockHandler('get_project_state', args) as MockEnvelopeState | null;
            if (!state?.project) return new ArrayBuffer(0) satisfies MockReply<'get_project_state_binary'>;
            return packStateEnvelope(state, {
              loading_id: 0,
              is_remote: false,
              newer_schema_version: null,
              speleo_link_unreadable: false,
              unreadable_project_settings: [],
              load_repairs: { shots: 0, section_offsets: 0, station_offsets: 0, gps_points: 0 },
              warnings: [],
              display_settings: {},
            }) satisfies MockReply<'get_project_state_binary'>;
          }

          case 'save_project': {
            // #576 B6-D1: a project a newer build saved refuses every save, in place
            // and Save As alike, with the code `surfaceSaveFailure` routes on.
            if (openProjectNewerSchema !== null) {
              return Promise.reject({
                code: 'NEWER_FILE_READ_ONLY',
                message:
                  `Saving is disabled: this project was saved by a newer ` +
                  `version of Stalagmight (file format ${openProjectNewerSchema}) and is open ` +
                  `read-only. Update Stalagmight to edit it.`,
              } satisfies CommandError);
            }
            // #576 B35(b): a link row the open could not read refuses every save that
            // would rewrite this file (the backend's code and message, save_sidecars.rs
            // `read_speleo_link`); a Save As to another file goes ahead and the session
            // moves there, unlinked.
            if (openProjectSpeleoLinkUnreadable) {
              const target = (args?.path as string | undefined) ?? projectPath;
              if (target === projectPath) {
                return Promise.reject({
                  code: 'SPELEODB_LINK_UNREADABLE',
                  message:
                    "Can't save: this project's SpeleoDB link could not be read (no such column: " +
                    'project_name). Saving would rewrite the file without it, so nothing was ' +
                    'written - the file on disk is unchanged. Use Save As to save your changes ' +
                    'to another file.',
                } satisfies CommandError);
              }
              openProjectSpeleoLinkUnreadable = false;
            }
            // Mirror the backend's Save-a-Copy contract: an EXPLICIT destination
            // on a SpeleoDB-managed project writes a detached unlinked copy - the
            // session does NOT move (projectPath/file_path untouched) and the
            // result carries unlinked_copy_path instead of saved_path.
            if (projectIsRemote && args?.path) {
              return {
                saved_path: null,
                unlinked_copy_path: args.path as string,
                warnings: [],
              } satisfies MockReply<'save_project'>;
            }
            projectPath = (args?.path as string) ?? projectPath;
            if (currentProject && projectPath) {
              currentProject.file_path = projectPath;
            }
            return { saved_path: projectPath, unlinked_copy_path: null, warnings: [] } satisfies MockReply<'save_project'>;
          }

          case 'close_project': {
            currentProject = null;
            projectPath = null;
            openProjectNewerSchema = null;
            mockWorkspaceMode = 'survey'; // #576 C5
            openProjectSpeleoLinkUnreadable = false;
            return { warnings: [] } satisfies MockReply<'close_project'>;
          }

          case 'cancel_loading': {
            // Idempotent - does nothing but shouldn't error
            return null satisfies MockReply<'cancel_loading'>;
          }

          case 'get_recent_logs':
            // DebugDialog expects string[] log lines prefixed with a level.
            return ['INFO [mock] app started', 'DEBUG [mock] project loaded'] satisfies MockReply<'get_recent_logs'>;

          // The debug memory probe: an idle backend and no WebKit children to enumerate.
          case 'get_memory_stats':
            return {
              backend: {
                pid: 1,
                name: 'stalagmight',
                rss_kb: 0,
                vm_size_kb: 0,
                vm_peak_kb: 0,
                vm_rss_anon_kb: 0,
                vm_rss_file_kb: 0,
                vm_rss_shmem_kb: 0,
                role: 'backend',
              },
              webkit_processes: [],
              total_rss_kb: 0,
              webkit_enumeration_supported: false,
            } satisfies MockReply<'get_memory_stats'>;

          case 'get_internal_error_status':
            // [#576 RV5-PI-3] No crash in a mocked session: no banner to raise.
            return null satisfies MockReply<'get_internal_error_status'>;

          case 'get_project_state': {
            // [#576 NF-W5I-1] No project open: the backend resolves the whole reply null
            // (ProjectState | null), not a state whose project is null.
            if (!currentProject) return null satisfies MockReply<'get_project_state'>;
            // Generate mock stations from sections with merged_with data
            const mockStations: Array<{
              station_ref: { section_id: number; station_index: number };
              coordinates: { x: number; y: number; z: number };
              is_zero_datum: boolean;
              gps_coordinates: { latitude: number; longitude: number; depth_reference: number } | null;
              merged_with: Array<{ section_id: number; station_index: number }>;
              // Optional, exactly like the generated `Station` type: the backend
              // omits `closures_with` when empty (#441), so the mock must too -
              // a present-but-empty array is a wire shape the app never sees.
              closures_with?: Array<{
                closure_id: number;
                station_ref: { section_id: number; station_index: number };
                via_station: { section_id: number; station_index: number } | null;
                is_transitive: boolean;
              }>;
              comment?: string;
            }> = [];

            // [#576 E3] Stations are a placeholder layout (station i of a section at x = 10 i,
            // y = 0, z = 0), with the stored merges, closures, datums and comments echoed
            // onto the stations they name. The real station geometry is the backend's.
            const stateMerges = (currentProject?.station_merges ?? []) as Array<{
              station_a: { section_id: number; station_index: number };
              station_b: { section_id: number; station_index: number };
            }>;
            const stateClosures = (currentProject?.loop_closures ?? []) as Array<{
              id: number;
              station_a: { section_id: number; station_index: number };
              station_b: { section_id: number; station_index: number };
            }>;

            // Build zero_datums lookup for deriving is_zero_datum and gps_coordinates
            const zeroDatums = (currentProject?.zero_datums ?? []) as Array<{
              station_ref: { section_id: number; station_index: number };
              gps: { latitude: number; longitude: number; depth_reference: number };
            }>;

            if (currentProject?.sections) {
              for (const section of currentProject.sections as Array<{ id: number; shots: unknown[] }>) {
                // Each section gets (shots.length + 1) stations
                const shotCount = section.shots?.length ?? 0;

                for (let i = 0; i <= shotCount; i++) {
                  const stationRef = { section_id: section.id, station_index: i };
                  const mergedWith: Array<{ section_id: number; station_index: number }> = stateMerges
                    .flatMap((merge) => {
                      const isA =
                        merge.station_a.section_id === stationRef.section_id &&
                        merge.station_a.station_index === stationRef.station_index;
                      const isB =
                        merge.station_b.section_id === stationRef.section_id &&
                        merge.station_b.station_index === stationRef.station_index;
                      if (isA) return [merge.station_b];
                      if (isB) return [merge.station_a];
                      return [];
                    });

                  // Derive is_zero_datum and gps_coordinates from project zero_datums
                  const matchingDatum = zeroDatums.find(
                    (d) => d.station_ref.section_id === section.id && d.station_ref.station_index === i
                  );
                  const closuresWith = stateClosures.flatMap((closure) => {
                    const isA =
                      closure.station_a.section_id === stationRef.section_id &&
                      closure.station_a.station_index === stationRef.station_index;
                    const isB =
                      closure.station_b.section_id === stationRef.section_id &&
                      closure.station_b.station_index === stationRef.station_index;
                    if (isA) {
                      return [{
                        closure_id: closure.id,
                        station_ref: closure.station_b,
                        via_station: null,
                        is_transitive: false,
                      }];
                    }
                    if (isB) {
                      return [{
                        closure_id: closure.id,
                        station_ref: closure.station_a,
                        via_station: null,
                        is_transitive: false,
                      }];
                    }
                    return [];
                  });

                  const storedComment = mockStationComments[`${section.id}:${i}`];
                  mockStations.push({
                    station_ref: stationRef,
                    coordinates: { x: i * 10, y: 0, z: 0 },
                    is_zero_datum: !!matchingDatum,
                    gps_coordinates: matchingDatum ? matchingDatum.gps : null,
                    merged_with: mergedWith,
                    ...(closuresWith.length > 0 ? { closures_with: closuresWith } : {}),
                    ...(storedComment !== undefined ? { comment: storedComment } : {}),
                  });
                }
              }
            }

            const shotCount =
              currentProject?.sections.reduce(
                (count: number, section) =>
                  count + ((section as { shots?: unknown[] }).shots?.length ?? 0),
                0
              ) ?? 0;

            return {
              // Return a FRESH (deep-cloned) project each call, mirroring the real Tauri
              // IPC: the backend returns `project.clone()` serialized over IPC, so the
              // project AND every nested array (sections, zero_datums, loop_closures, …)
              // gets a new identity per call. The mock mutates those arrays in place
              // (e.g. sections.push in create_section, datums.push in set_zero_datum),
              // so returning the same reference froze #160's reference-keyed memos -
              // `useMemo([sections])` left the SectionsPanel empty even as fresh `stats`
              // showed the populated count. A deep clone keeps every consumer's
              // ref-identity check honest, not just the sections one. (Caused ~50
              // full-suite failures; smoke seeds once, so it never hit this.)
              // shape not checked: the mock's loose project record (null is answered above)
              project: structuredClone(currentProject) as unknown as NonNullable<
                MockReply<'get_project_state'>
              >['project'],
              stations: mockStations,
              // [#576 E3] Counts of what is stored; the figures the backend derives from the
              // survey (total length, depth range, penetration, loops - ProjectStats, pinned by
              // models `stats_single_section` / `stats_multiple_sections` /
              // `depth_range_is_absolute_not_a_delta_walk`) are canned at 0.
              stats: {
                section_count: currentProject?.sections.length ?? 0,
                shot_count: shotCount,
                total_length: 0,
                min_depth: 0,
                max_depth: 0,
                station_count: mockStations.length,
                loop_count: 0,
                penetration_distance: 0,
              },
              frozen_shots: [],
            } satisfies MockReply<'get_project_state'>;
          }

          case 'get_adjusted_stations': {
            // Closure-adjusted geometry view. The mock has no real least-squares
            // solver, so the adjusted geometry is identical to measured: reuse the
            // station array get_project_state builds.
            // shape not checked: mockHandler returns unknown; the get_project_state case checks this value
            const state = mockHandler('get_project_state', args) as MockReply<'get_project_state'>;
            return (state?.stations ?? []) satisfies MockReply<'get_adjusted_stations'>;
          }

          case 'get_station_distances_from': {
            // Distance-gradient field (#34). No real graph in the mock - synthesize
            // distances from each station's mock x-coordinate (origin at x=0) so the
            // overlay + legend have finite values to render. `from` is ignored.
            const state = mockHandler('get_project_state', args) as
              | {
                  stations?: Array<{
                    station_ref: { section_id: number; station_index: number };
                    coordinates: { x: number; y: number; z: number };
                  }>;
                }
              | null;
            const stations = state?.stations ?? [];
            let max = 0;
            const distances = stations.map((s) => {
              const d = Math.abs(s.coordinates.x);
              if (d > max) max = d;
              return d;
            });
            return {
              distances,
              station_refs: stations.map((s) => s.station_ref),
              max_reachable: max,
            } satisfies MockReply<'get_station_distances_from'>;
          }

          case 'get_along_line_distance': {
            // Ruler along-line distance (#26). No real survey graph in the mock -
            // return a deterministic distance and tint the first couple of shots
            // of endpoint `a`'s section so the readout + tint have something to show.
            const endpointA = (args?.a ?? null) as { section_id?: number } | null;
            const sections = (currentProject?.sections ?? []) as Array<{ id: number; shots: Array<{ id: number }> }>;
            const sec = sections.find((s) => s.id === endpointA?.section_id) ?? sections[0];
            const path_shots = sec
              ? (sec.shots ?? []).slice(0, 2).map((sh) => ({ section_id: sec.id, shot_id: sh.id }))
              : [];
            // Stations bounding those shots (one more than the shot count).
            const path_stations = sec
              ? Array.from({ length: path_shots.length + 1 }, (_, i) => ({ section_id: sec.id, station_index: i }))
              : [];
            return { along_line: 12.34, path_shots, path_stations } satisfies MockReply<'get_along_line_distance'>;
          }

          case 'create_section': {
            sectionCounter++;
            const rawShots = Array.isArray(args?.shots) ? (args?.shots as Array<Record<string, unknown>>) : [];
            // #310: every shot gets a stable uuid (ipc/shots.ts) - the neighbour-pair anchors
            // above key off it, exactly as the real backend keys off `Shot.uuid`.
            const shots = rawShots.map((shot, index) => buildShot(mockShotId(sectionCounter, index), shot));
            const section = {
              id: sectionCounter,
              name: (args?.name as string) ?? `Section ${sectionCounter}`,
              surveyor: 'Test Surveyor',
              date: new Date().toISOString().split('T')[0],
              color: '#3b82f6',
              shots,
            };
            currentProject?.sections.push(section);
            return { section_id: sectionCounter, warnings: [], remote_link: remoteLink() } satisfies MockReply<'create_section'>;
          }

          case 'import_sections': {
            console.log('[Mock IPC] import_sections called with:', args);
            const rawSections = Array.isArray(args?.sections) ? (args?.sections as Array<Record<string, unknown>>) : [];
            if (rawSections.length === 0) {
              // Mirrors the real backend's `sections.is_empty()` early return
              // (execute_import_sections, command_import.rs): no receipt when
              // nothing was imported.
              return { section_ids: [], import_receipt: null, warnings: [], remote_link: remoteLink() } satisfies MockReply<'import_sections'>;
            }
            if (!currentProject) {
              const now = new Date().toISOString();
              sectionCounter = 0;
              currentProject = {
                id: 1,
                name: 'Imported Project',
                location: null,
                created_at: now,
                modified_at: now,
                file_path: null,
                sections: [],
                station_merges: [],
                zero_datums: [],
                loop_closures: [],
                section_offsets: {},
              };
            }
            const importedSections = rawSections.map((sectionData) => {
              sectionCounter++;
              const rawShots = Array.isArray(sectionData.shots) ? (sectionData.shots as Array<Record<string, unknown>>) : [];
              // Through the shared builder, so an imported shot has a uuid too (#576 NF-FIX3B-2).
              const shots = rawShots.map((shot, index) => buildShot(mockShotId(sectionCounter, index), shot));
              const section = {
                id: sectionCounter,
                name: (sectionData.name as string) ?? `Section ${sectionCounter}`,
                surveyor: (sectionData.surveyor as string) ?? 'Test Surveyor',
                date: (sectionData.date as string) ?? new Date().toISOString().split('T')[0],
                color: (sectionData.color as string) ?? '#3b82f6',
                direction: (sectionData.direction as string) ?? 'in',
                shots,
              };
              currentProject?.sections.push(section);
              return section;
            });
            const sectionIds = importedSections.map((section) => section.id as number);
            const importedShotCount = importedSections.reduce(
              (sum, section) => sum + (section.shots as unknown[]).length,
              0
            );
            const sourceLabel = (args?.sourceLabel as string | null | undefined) ?? null;
            const sourceFileName = (args?.sourceFileName as string | null | undefined) ?? null;
            const sectionsFoundArg = (args?.sectionsFound as number | null | undefined) ?? null;
            // The file's parse warnings lead the receipt (#576 B13), as in
            // `import_sections`' `lead_receipt_with_source_warnings`.
            const sourceWarnings = Array.isArray(args?.sourceWarnings)
              ? (args?.sourceWarnings as string[]).filter((w) => w.length > 0)
              : [];
            return {
              warnings: [],
              remote_link: remoteLink(),
              section_ids: sectionIds,
              import_receipt: {
                source_format: sourceLabel ?? 'mNemo DMP',
                file_name: sourceFileName ?? '',
                sections_found: sectionsFoundArg ?? sectionIds.length,
                sections_imported: sectionIds.length,
                shot_count: importedShotCount,
                closures_requested: 0,
                closures_created: 0,
                unit_conversion: null,
                warnings: sourceWarnings,
                info: [],
                zero_datum_created: null,
              },
            } satisfies MockReply<'import_sections'>;
          }

          case 'execute_walls_import': {
            // Record the import args (selectedSurveys, includeSplays, …) for
            // assertions, then return a one-section success so the dialog runs
            // its "imported" exit path (not the "nothing imported" branch).
            wallsImportCalls.push({ ...(args ?? {}) });
            const wallsPath = (args?.path as string | undefined) ?? '';
            const wallsFileName = wallsPath.split('/').pop() ?? wallsPath;
            return {
              warnings: [],
              remote_link: remoteLink(),
              section_ids: [1],
              import_receipt: {
                source_format: 'Walls',
                file_name: wallsFileName,
                sections_found: 1,
                sections_imported: 1,
                shot_count: 0,
                closures_requested: 0,
                closures_created: 0,
                unit_conversion: null,
                warnings: [],
                info: [],
                zero_datum_created: null,
              },
            } satisfies MockReply<'execute_walls_import'>;
          }

          // A one-survey Walls project, canned: what the parser reads out of a real file
          // is pinned by the parsers crate's Walls tests.
          case 'parse_walls':
            return {
              project_name: 'CaveA',
              book_count: 1,
              survey_count: 1,
              resolved_survey_count: 1,
              shot_count: 3,
              splay_count: 0,
              has_georeference: false,
              datum: null,
              utm_zone: null,
              fixed_station_count: 0,
              missing_file_count: 0,
              skipped_attachment_count: 0,
              any_feet_units: false,
              surveys: [
                {
                  name: 'A1',
                  title: 'Survey A1',
                  date: '2024-03-01',
                  segment: '',
                  shot_count: 3,
                  splay_count: 0,
                  fixed_station_count: 0,
                  resolved: true,
                },
              ],
              warnings: [],
            } satisfies MockReply<'parse_walls'>;

          // File hash tracking for duplicate detection
          case 'calculate_file_hash':
            // Return a mock SHA256 hash based on path for consistency
            return `mock_hash_${(args?.path as string)?.split('/').pop() ?? 'unknown'}` satisfies MockReply<'calculate_file_hash'>;

          case 'check_duplicate_import':
            // Configurable via __MOCK_SET_CHECK_DUPLICATE_RESULT__
            return mockCheckDuplicateResult satisfies MockReply<'check_duplicate_import'>;

          case 'parse_gpx': {
            return buildMockGpxFile(args?.path as string | undefined) satisfies MockReply<'parse_gpx'>;
          }

          case 'execute_gpx_import': {
            // [#576 E3] Canned: the file's two waypoints, its track and its route land as
            // four sections with a zero datum each, whatever the dialog chose. Turning GPX
            // points into shots (bearing, slope length, depth from elevation, the depth sign
            // option) and a placement into a datum is the backend's (parsers gpx.rs tests).
            if (!currentProject) {
              return Promise.reject({ code: 'FAILED', message: 'No project open' } satisfies CommandError);
            }
            const gpxSections: Array<{
              name: string;
              color: string;
              shots: Array<Record<string, unknown>>;
              gps: { latitude: number; longitude: number; depth_reference: number };
            }> = [
              { name: 'Entry Bell', color: '#4a90d9', shots: [], gps: { latitude: 24.55, longitude: -81.78, depth_reference: 0 } },
              { name: 'Jump Reel', color: '#4a90d9', shots: [], gps: { latitude: 24.5504, longitude: -81.7794, depth_reference: 0 } },
              {
                name: 'Main Line',
                color: '#3b82f6',
                shots: [
                  { azimuth_in: 40, azimuth_out: 40, length: 28.6, depth_in: -2, depth_out: -2.6 },
                  { azimuth_in: 50, azimuth_out: 50, length: 42.6, depth_in: -2.6, depth_out: -3.1 },
                ],
                gps: { latitude: 24.55, longitude: -81.78, depth_reference: 0 },
              },
              {
                name: 'Exit Route',
                color: '#22c55e',
                shots: [
                  { azimuth_in: 56, azimuth_out: 56, length: 40.1, depth_in: -3.1, depth_out: -2.8 },
                  { azimuth_in: 63, azimuth_out: 63, length: 37.0, depth_in: -2.8, depth_out: -2.5 },
                ],
                gps: { latitude: 24.55045, longitude: -81.7795, depth_reference: 0 },
              },
            ];
            const gpxSectionIds: number[] = [];
            for (const landed of gpxSections) {
              sectionCounter += 1;
              const sectionId = sectionCounter;
              currentProject.sections.push({
                id: sectionId,
                name: landed.name,
                surveyor: 'GPX Import',
                date: new Date().toISOString().split('T')[0] ?? '',
                color: landed.color,
                direction: 'in',
                shots: landed.shots.map((shot, index) => buildShot(mockShotId(sectionId, index), shot)),
              });
              (currentProject.zero_datums as unknown[]).push({
                station_ref: { section_id: sectionId, station_index: 0 },
                gps: landed.gps,
              });
              gpxSectionIds.push(sectionId);
            }
            const gpxPath = (args?.path as string | undefined) ?? '';
            return {
              warnings: [],
              remote_link: remoteLink(),
              section_ids: gpxSectionIds,
              import_receipt: {
                source_format: 'GPX',
                file_name: gpxPath.split('/').pop() ?? gpxPath,
                sections_found: 4,
                sections_imported: 4,
                shot_count: 4,
                closures_requested: 0,
                closures_created: 0,
                unit_conversion: null,
                warnings: [],
                info: [],
                zero_datum_created: null,
              },
            } satisfies MockReply<'execute_gpx_import'>;
          }

          case 'parse_tml':
            return buildMockTmlFile(args?.path as string | undefined) satisfies MockReply<'parse_tml'>;

          case 'execute_tml_import': {
            // [#576 E3] Recorded (every option the dialog sent, for the spec to assert), and
            // canned: the synthetic file lands as it does under the default options, whatever
            // was sent - Main Line with its two kept shots, Side Passage with its real shot
            // and its virtual one (a Jump), Side Passage's station 0 merged with Main Line's
            // station 1, the file's one loop closure, and Main Line's commented shot's note
            // on its station. What the options change (excluded shots, the virtual-shot kind,
            // a deselected section, comments on stations), the merges and closures, and the
            // receipt's counts are the backend's (parsers tml tests, core
            // command_import tests and mock_narrowing_tests.rs).
            tmlImportCalls.push({ ...(args ?? {}) });
            if (!currentProject) {
              return Promise.reject({ code: 'FAILED', message: 'No project open' } satisfies CommandError);
            }
            const tmlPath = (args?.path as string | undefined) ?? '';
            const mainId = sectionCounter + 1;
            const sideId = sectionCounter + 2;
            sectionCounter += 2;
            const landedShot = (azimuth: number, depthIn: number, depthOut: number, kind: string) => ({
              azimuth_in: azimuth,
              azimuth_out: azimuth,
              length: 10,
              depth_in: depthIn,
              depth_out: depthOut,
              pitch_in: 0,
              left: 1,
              right: 1,
              up: 1,
              down: 1,
              kind,
            });
            currentProject.sections.push(
              {
                id: mainId,
                name: 'Main Line',
                surveyor: 'Synthetic Surveyor',
                date: '2026-01-02',
                color: '#3b82f6',
                direction: 'in',
                shots: [landedShot(30, 1, 2, 'Normal'), landedShot(60, 3, 4, 'Normal')].map((shot, index) =>
                  buildShot(mockShotId(mainId, index), shot),
                ),
              },
              {
                id: sideId,
                name: 'Side Passage',
                surveyor: 'Synthetic Surveyor',
                date: '2026-01-03',
                color: '#22c55e',
                direction: 'in',
                shots: [landedShot(120, 2, 3, 'Normal'), landedShot(150, 4, 5, 'Jump')].map((shot, index) =>
                  buildShot(mockShotId(sideId, index), shot),
                ),
              },
            );
            (currentProject.station_merges as unknown[]).push({
              station_a: { section_id: sideId, station_index: 0 },
              station_b: { section_id: mainId, station_index: 1 },
            });
            const closures = currentProject.loop_closures as Array<{ id: number }>;
            closures.push({
              id: closures.reduce((max, c) => Math.max(max, c.id), 0) + 1,
              station_a: { section_id: mainId, station_index: 1 },
              station_b: { section_id: sideId, station_index: 1 },
              path_length: 0,
              misclosure_distance: 0,
              error_percentage: 0,
              horizontal_misclosure: 0,
              vertical_misclosure: 0,
              strategy: 'Batch',
              is_aligned: false,
            } as { id: number });
            mockStationComments[`${mainId}:2`] = 'Restriction at the T';
            currentProject.modified_at = new Date().toISOString();
            return {
              warnings: [],
              remote_link: remoteLink(),
              section_ids: [mainId, sideId],
              import_receipt: {
                source_format: 'Ariane TML',
                file_name: tmlPath.split('/').pop() ?? tmlPath,
                sections_found: 2,
                sections_imported: 2,
                shot_count: 4,
                closures_requested: 1,
                closures_created: 1,
                unit_conversion: null,
                warnings: [],
                info: [],
                zero_datum_created: null,
              },
            } satisfies MockReply<'execute_tml_import'>;
          }

          case 'merge_stations': {
            console.log('[Mock IPC] merge_stations called with:', args);
            const stationA = (args?.stationA ?? args?.station_a) as
              | { section_id: number; station_index: number }
              | undefined;
            const stationB = (args?.stationB ?? args?.station_b) as
              | { section_id: number; station_index: number }
              | undefined;
            if (stationA && stationB) {
              mergeStationCalls.push({ stationA, stationB });
              if (currentProject) {
                (currentProject.station_merges as Array<{
                  station_a: { section_id: number; station_index: number };
                  station_b: { section_id: number; station_index: number };
                }>).push({
                  station_a: stationA,
                  station_b: stationB,
                });
              }
            }
            return { warnings: [], remote_link: remoteLink() } satisfies MockReply<'merge_stations'>;
          }

          case 'execute_batch': {
            // Mock execute batch - track calls for assertions and return success
            console.log('[Mock IPC] execute_batch called with:', args);
            const win = window as unknown as Record<string, unknown>;
            const existing = win.__MOCK_EXECUTE_BATCH_CALLS__ as unknown[] | undefined;
            const calls = Array.isArray(existing) ? existing : [];
            calls.push(args?.commands ?? null);
            win.__MOCK_EXECUTE_BATCH_CALLS__ = calls;
            // Apply contained update_shot commands to currentProject (reusing
            // the update_shot mutation) so a multi-cell paste/fill survives
            // the store's post-command refresh. Nested batch payloads bypass
            // Tauri's top-level camelCase conversion and stay snake_case.
            const commands = (Array.isArray(args?.commands) ? args?.commands : []) as Array<
              Record<string, unknown>
            >;
            // [#576 E3] No rollback: the real execute_batch is all-or-nothing (it snapshots the
            // whole project and restores it on a failed sub-command, pinned by the core batch
            // tests), and the mock does not re-implement that. A refused sub-command's
            // rejection is the batch's answer; what earlier steps stored stays stored.
            // Each reverse sub-command's canned entry, in step order. (The backend also nets
            // out a section reversed twice in one batch; the UI never sends one twice.)
            const reversedSections: Array<{ section_id: number; shot_count: number }> = [];
            for (const command of commands) {
              // A sub-command's reply, from this mock's own (checked) cases: its outcome, or
              // the rejected promise its failure is (#576 C4: a refusal is a rejection with
              // a `CommandError`, never a resolved value).
              let result: unknown;
              if (command?.type === 'update_shot') {
                result = mockHandler('update_shot', {
                  sectionId: command.section_id,
                  shotId: command.shot_id,
                  updates: command.updates,
                });
              } else if (command?.type === 'untrack_import') {
                // Rides the withdrawal batch (#394) so a re-import of the same
                // file is not reported as a duplicate. This mock does not keep
                // hash SETS (`check_section_hashes` answers false for everything
                // and `check_duplicate_import` reads one configurable flag), so
                // the faithful replay is to clear that flag.
                mockCheckDuplicateResult = false;
              } else if (command?.type === 'delete_section') {
                // Withdrawing an abandoned import (#394) removes N sections in
                // ONE batch, so the batch has to replay it or a cancelled DMP
                // import would look like it kept everything.
                result = mockHandler('delete_section', {
                  sectionId: command.section_id,
                });
              } else if (command?.type === 'reverse_section') {
                // Multi-section reverse (#24) is batched so it is atomic and
                // costs one undo, so the batch has to replay it too.
                result = mockHandler('reverse_section', {
                  sectionId: command.section_id,
                  swapLeftRight: command.swap_left_right,
                });
                const reversed = (result as Partial<MockReply<'reverse_section'>> | null)?.reversed_sections;
                if (reversed) {
                  reversedSections.push(...reversed);
                }
              }
              if (result instanceof Promise) {
                // The sub-command was refused: its CommandError rejection answers the batch.
                return result;
              }
            }
            return {
              section_ids: [],
              reversed_sections: reversedSections,
              warnings: [],
              remote_link: remoteLink(),
            } satisfies MockReply<'execute_batch'>;
          }

          case 'check_merge_connectivity': {
            // Mock connectivity check
            // Default: not connected but merge allowed (opens merge dialog)
            // Tests can override via __MOCK_CONNECTIVITY_RESULT__
            console.log('[Mock IPC] check_merge_connectivity called with:', args);
            // shape not checked: a spec-injected __MOCK_CONNECTIVITY_RESULT__, passed through as given
            const mockConnectivity = (window as unknown as Record<string, unknown>).__MOCK_CONNECTIVITY_RESULT__ as
              | MockReply<'check_merge_connectivity'>
              | undefined;
            if (mockConnectivity) {
              return mockConnectivity satisfies MockReply<'check_merge_connectivity'>;
            }
            return { connected: false, preview: null, can_merge: true, reason: null, reason_code: null } satisfies MockReply<'check_merge_connectivity'>;
          }

          case 'create_loop_closure': {
            console.log('[Mock IPC] create_loop_closure called with:', args);
            const stationA = (args?.stationA ?? args?.station_a) as
              | { section_id: number; station_index: number }
              | undefined;
            const stationB = (args?.stationB ?? args?.station_b) as
              | { section_id: number; station_index: number }
              | undefined;
            const closureStrategy = (args?.closureStrategy ?? args?.closure_strategy) as string | undefined;
            if (!stationA || !stationB) {
              return Promise.reject({ code: 'FAILED', message: 'Missing closure stations' } satisfies CommandError);
            }

            if (currentProject) {
              const loopClosures = currentProject.loop_closures as Array<{
                id: number;
                station_a: { section_id: number; station_index: number };
                station_b: { section_id: number; station_index: number };
                path_length: number;
                misclosure_distance: number;
                error_percentage: number;
                horizontal_misclosure: number;
                vertical_misclosure: number;
                strategy: string;
                is_aligned: boolean;
              }>;

              // [#576 E3] Stored as asked. Refusing a duplicate pair (in either order) is the
              // backend's rule, pinned by models `create_loop_closure_rejects_duplicate`.
              const maxExistingId = loopClosures.reduce(
                (maxId, closure) => (closure.id > maxId ? closure.id : maxId),
                0
              );
              const nextId = maxExistingId + 1;

              loopClosures.push({
                id: nextId,
                station_a: stationA,
                station_b: stationB,
                path_length: 0,
                misclosure_distance: 0,
                error_percentage: 0,
                horizontal_misclosure: 0,
                vertical_misclosure: 0,
                strategy: closureStrategy ?? 'Batch',
                is_aligned: false,
              });
            }

            return { warnings: [], remote_link: remoteLink() } satisfies MockReply<'create_loop_closure'>;
          }

          case 'remove_loop_closure': {
            console.log('[Mock IPC] remove_loop_closure called with:', args);
            const closureIdRaw = args?.closureId ?? args?.closure_id;
            if (closureIdRaw === undefined || closureIdRaw === null) {
              return Promise.reject({ code: 'FAILED', message: 'Missing closure ID' } satisfies CommandError);
            }
            // A u64 on the Rust side: serde accepts only a JSON number.
            const closureId = typeof closureIdRaw === 'number' ? closureIdRaw : null;
            if (closureId === null) {
              return Promise.reject({ code: 'FAILED', message: 'Invalid closure ID' } satisfies CommandError);
            }

            if (!currentProject) {
              return Promise.reject({ code: 'FAILED', message: 'No project open' } satisfies CommandError);
            }

            const loopClosures = currentProject.loop_closures as Array<{ id: number }>;
            const closureIndex = loopClosures.findIndex((closure) => closure.id === closureId);
            if (closureIndex < 0) {
              return Promise.reject({ code: 'FAILED', message: 'Loop closure not found' } satisfies CommandError);
            }

            loopClosures.splice(closureIndex, 1);
            return { warnings: [], remote_link: remoteLink() } satisfies MockReply<'remove_loop_closure'>;
          }

          case 'unmerge_stations':
            // Mock unmerge stations - return success
            console.log('[Mock IPC] unmerge_stations called with:', args);
            if (currentProject && args) {
              const stationRef = (args.stationRef ?? args.station_ref) as { section_id: number; station_index: number } | undefined;
              if (stationRef) {
                const stationMerges = currentProject.station_merges as Array<{
                  station_a: { section_id: number; station_index: number };
                  station_b: { section_id: number; station_index: number };
                }>;

                // [#576 E3] Only the merge records naming the station go. Dropping the loop
                // closures over a removed pair is the backend's rule (models
                // `unmerge_stations_removes_matching_closure_and_preserves_others`).
                for (let i = stationMerges.length - 1; i >= 0; i -= 1) {
                  const merge = stationMerges[i]!;
                  const touchesStation =
                    (merge.station_a.section_id === stationRef.section_id && merge.station_a.station_index === stationRef.station_index) ||
                    (merge.station_b.section_id === stationRef.section_id && merge.station_b.station_index === stationRef.station_index);
                  if (touchesStation) stationMerges.splice(i, 1);
                }
              }
            }
            return { warnings: [], remote_link: remoteLink() } satisfies MockReply<'unmerge_stations'>;

          case 'unmerge_station_pair': {
            console.log('[Mock IPC] unmerge_station_pair called with:', args);
            const stationA = (args?.stationA ?? args?.station_a) as { section_id: number; station_index: number } | undefined;
            const stationB = (args?.stationB ?? args?.station_b) as { section_id: number; station_index: number } | undefined;
            if (!stationA || !stationB) {
              return Promise.reject({ code: 'FAILED', message: 'Missing station pair' } satisfies CommandError);
            }

            unmergeStationPairCalls.push({ stationA, stationB });

            if (currentProject) {
              const stationMerges = currentProject.station_merges as Array<{
                station_a: { section_id: number; station_index: number };
                station_b: { section_id: number; station_index: number };
              }>;

              const matchIndex = stationMerges.findIndex((merge) => {
                const direct =
                  merge.station_a.section_id === stationA.section_id &&
                  merge.station_a.station_index === stationA.station_index &&
                  merge.station_b.section_id === stationB.section_id &&
                  merge.station_b.station_index === stationB.station_index;
                const reverse =
                  merge.station_b.section_id === stationA.section_id &&
                  merge.station_b.station_index === stationA.station_index &&
                  merge.station_a.section_id === stationB.section_id &&
                  merge.station_a.station_index === stationB.station_index;
                return direct || reverse;
              });

              // [#576 E3] Only the merge record goes. The closure cascade and the refusal of a
              // pair that is not directly merged are the backend's (models
              // `unmerge_stations_removes_matching_closure_and_preserves_others`, core
              // `unmerging_a_pair_that_is_not_merged_is_refused`).
              if (matchIndex >= 0) stationMerges.splice(matchIndex, 1);
            }
            return { warnings: [], remote_link: remoteLink() } satisfies MockReply<'unmerge_station_pair'>;
          }

          case 'move_segment': {
            // Record the dispatched offset for commit-assertion tests. These handlers
            // don't mutate currentProject (refreshProjectState refetches generated
            // coords), so tests assert on the committed offset, not a coord read-back.
            console.log('[Mock IPC] move_segment called with:', args);
            const win = window as unknown as Record<string, unknown>;
            const calls = (win.__MOCK_MOVE_CALLS__ as unknown[]) ?? [];
            calls.push({ command: 'move_segment', args: args ?? null });
            win.__MOCK_MOVE_CALLS__ = calls;
            return { warnings: [], remote_link: remoteLink() } satisfies MockReply<'move_segment'>;
          }

          case 'move_section': {
            // Record the dispatched offset (mirrors move_segment/move_station) so
            // commit-assertion tests can check the offset that reached the backend.
            console.log('[Mock IPC] move_section called with:', args);
            const win = window as unknown as Record<string, unknown>;
            const calls = (win.__MOCK_MOVE_CALLS__ as unknown[]) ?? [];
            calls.push({ command: 'move_section', args: args ?? null });
            win.__MOCK_MOVE_CALLS__ = calls;
            return { warnings: [], remote_link: remoteLink() } satisfies MockReply<'move_section'>;
          }

          case 'move_station': {
            console.log('[Mock IPC] move_station called with:', args);
            const win = window as unknown as Record<string, unknown>;
            const calls = (win.__MOCK_MOVE_CALLS__ as unknown[]) ?? [];
            calls.push({ command: 'move_station', args: args ?? null });
            win.__MOCK_MOVE_CALLS__ = calls;
            return { warnings: [], remote_link: remoteLink() } satisfies MockReply<'move_station'>;
          }

          case 'get_anchored_section_ids':
            // Return section IDs that have zero datums
            console.log('[Mock IPC] get_anchored_section_ids called');
            if (currentProject) {
              const datums = (currentProject.zero_datums ?? []) as Array<{
                station_ref: { section_id: number; station_index: number };
              }>;
              const anchoredIds = [...new Set(datums.map(d => d.station_ref.section_id))];
              anchoredIds.sort((a, b) => a - b);
              return anchoredIds satisfies MockReply<'get_anchored_section_ids'>;
            }
            return [] satisfies MockReply<'get_anchored_section_ids'>;

          case 'set_zero_datum': {
            console.log('[Mock IPC] set_zero_datum called with:', args);
            // Update currentProject's zero_datums to reflect the change
            if (currentProject && args) {
              const stationRef = args.stationRef as { section_id: number; station_index: number };
              const coordinates = args.coordinates as { latitude: number; longitude: number; depth_reference: number };
              const datums = currentProject.zero_datums as Array<{
                station_ref: { section_id: number; station_index: number };
                gps: { latitude: number; longitude: number; depth_reference: number };
              }>;
              // Update in-place if exists, otherwise push
              const existing = datums.find(
                (d) =>
                  d.station_ref.section_id === stationRef.section_id &&
                  d.station_ref.station_index === stationRef.station_index
              );
              if (existing) {
                existing.gps = coordinates;
              } else {
                // In-place mutation (same array identity) is load-bearing for the
                // deep-clone reactivity guard: datum-closure-reactivity.spec.ts only
                // catches a shallow-clone regression because the fresh array identity
                // comes from get_project_state's structuredClone, NOT from this write.
                // If this is ever changed to fresh-copy zero_datums, update that spec.
                datums.push({ station_ref: stationRef, gps: coordinates });
              }
            }
            return { warnings: [], remote_link: remoteLink() } satisfies MockReply<'set_zero_datum'>;
          }

          case 'remove_zero_datum': {
            console.log('[Mock IPC] remove_zero_datum called with:', args);
            // Remove datum from currentProject's zero_datums
            if (currentProject && args) {
              const stationRef = args.stationRef as { section_id: number; station_index: number };
              const datums = currentProject.zero_datums as Array<{
                station_ref: { section_id: number; station_index: number };
              }>;
              const idx = datums.findIndex(
                (d) =>
                  d.station_ref.section_id === stationRef.section_id &&
                  d.station_ref.station_index === stationRef.station_index
              );
              if (idx >= 0) {
                datums.splice(idx, 1);
              }
            }
            return { warnings: [], remote_link: remoteLink() } satisfies MockReply<'remove_zero_datum'>;
          }

          case 'set_station_comment': {
            console.log('[Mock IPC] set_station_comment called with:', args);
            const stationRef = args?.stationRef as { section_id: number; station_index: number };
            const comment = (args?.comment as string | null | undefined) ?? null;
            const key = `${stationRef.section_id}:${stationRef.station_index}`;
            if (comment === null) {
              delete mockStationComments[key];
            } else {
              mockStationComments[key] = comment;
            }
            return { warnings: [], remote_link: remoteLink() } satisfies MockReply<'set_station_comment'>;
          }

          // [#576 E3] Canned: a section moves alone, has no relationships to warn about, and
          // a warning (un)resolve or a comment move is acknowledged without changing the
          // project. Which sections are rigidly tied, what a delete would sever and how a
          // comment move swaps holders are the backend's, pinned by its Rust tests.
          case 'get_rigid_connected_section_ids':
            return [Number(args?.sectionId)] satisfies MockReply<'get_rigid_connected_section_ids'>;

          case 'get_section_relationships':
            return {
              merges: [],
              closures: [],
              has_section_offset: false,
              station_offset_count: 0,
              zero_datum_count: 0,
            } satisfies MockReply<'get_section_relationships'>;

          case 'resolve_warning':
          case 'unresolve_warning':
          case 'move_comment':
            return { warnings: [], remote_link: remoteLink() } satisfies MockReply<'resolve_warning'> &
              MockReply<'unresolve_warning'> &
              MockReply<'move_comment'>;

          case 'create_section_and_merge': {
            // The new section lands as create_section lands one, and the merge it asks
            // for is stored as merge_stations stores one.
            sectionCounter++;
            const rawShots = Array.isArray(args?.shots) ? (args?.shots as Array<Record<string, unknown>>) : [];
            currentProject?.sections.push({
              id: sectionCounter,
              name: (args?.name as string | null | undefined) ?? `Section ${sectionCounter}`,
              surveyor: 'Test Surveyor',
              date: new Date().toISOString().split('T')[0],
              color: (args?.color as string | undefined) ?? '#3b82f6',
              shots: rawShots.map((shot, index) => buildShot(mockShotId(sectionCounter, index), shot)),
            });
            const target = args?.targetStation as { section_id: number; station_index: number } | undefined;
            if (target) {
              (currentProject?.station_merges as unknown[] | undefined)?.push({
                station_a: { section_id: sectionCounter, station_index: Number(args?.importStationIndex ?? 0) },
                station_b: target,
              });
            }
            return { section_id: sectionCounter, warnings: [], remote_link: remoteLink() } satisfies MockReply<'create_section_and_merge'>;
          }

          case 'check_section_hashes': {
            const hashes = (Array.isArray(args?.hashes) ? args?.hashes : []) as string[];
            return hashes.map(() => false) satisfies MockReply<'check_section_hashes'>;
          }

          case 'suggest_import_placement':
            return [] satisfies MockReply<'suggest_import_placement'>;

          case 'suggest_all_import_placements':
            return [...mockImportPlacementSuggestions] satisfies MockReply<'suggest_all_import_placements'>;

          case 'suggest_orphan_placements':
            return [...mockOrphanPlacementSuggestions] satisfies MockReply<'suggest_orphan_placements'>;

          case 'count_unanchored_sections':
            return 0 satisfies MockReply<'count_unanchored_sections'>;

          case 'get_segment_geometry':
            return {
              sections: [
                {
                  section_id: (args?.sectionId as number | undefined) ?? 1,
                  color: '#4a90d9',
                  shot_lines: [[[0, 0], [10, 0]]],
                },
              ],
            } satisfies MockReply<'get_segment_geometry'>;

          case 'list_recent_projects':
            // `station_count: 0` / `is_remote: false` are what the UI read (`?? 0`, falsy)
            // while these rows omitted the two fields the backend always sends.
            return ([
              {
                name: 'Cave System Alpha',
                location: 'Yucatan, Mexico',
                file_path: '/projects/cave-alpha.stalx',
                modified_at: new Date().toISOString(),
                section_count: 5,
                total_length: 1250.5,
                station_count: 0,
                is_remote: false,
                gps_center: [-87.4631, 20.2137],
                gps_bounds: {
                  north: 20.2200,
                  south: 20.2074,
                  east: -87.4568,
                  west: -87.4694,
                },
              },
              {
                name: 'Underwater Cave Beta',
                location: 'Florida, USA',
                file_path: '/projects/cave-beta.stalx',
                modified_at: new Date(Date.now() - 86400000).toISOString(),
                section_count: 3,
                total_length: 820.0,
                station_count: 0,
                is_remote: false,
                gps_center: [-82.4584, 29.6516],
                gps_bounds: {
                  north: 29.6550,
                  south: 29.6482,
                  east: -82.4521,
                  west: -82.4647,
                },
              },
              {
                name: 'Deep Cave Gamma',
                location: 'Bahamas',
                file_path: '/projects/cave-gamma.stalx',
                modified_at: new Date(Date.now() - 172800000).toISOString(),
                section_count: 8,
                total_length: 2100.3,
                station_count: 0,
                is_remote: false,
                gps_center: [-77.3963, 25.0343],
                gps_bounds: null,
              },
              {
                name: 'Local Survey (No GPS)',
                location: 'Unknown',
                file_path: '/projects/local-survey.stalx',
                modified_at: new Date(Date.now() - 259200000).toISOString(),
                section_count: 2,
                total_length: 350.0,
                station_count: 0,
                is_remote: false,
                gps_center: null,
                gps_bounds: null,
              },
            ] satisfies MockReply<'list_recent_projects'>).filter((p) => !deletedProjectPaths.has(p.file_path)).map((p) =>
              recentNameOverrides[p.file_path]
                ? { ...p, name: recentNameOverrides[p.file_path] }
                : p
            ) satisfies MockReply<'list_recent_projects'>;

          case 'get_project_warnings':
            return [] satisfies MockReply<'get_project_warnings'>;

          case 'check_project_integrity':
            return { messages: mockIntegrityIssues, save_blocked: mockIntegritySaveBlocked } satisfies MockReply<'check_project_integrity'>;

          case 'history_discarded':
            // #473: whether the open project's edit history was unreadable and
            // replaced by an empty stack. A peek, not a take - the real command
            // keeps answering the same thing while the project is open, so the
            // mock must too or a re-render would clear the banner.
            mockHistoryDiscardedCalls += 1;
            return mockHistoryDiscarded satisfies MockReply<'history_discarded'>;

          case 'repair_project_integrity': {
            // #576 D39(a): a read-only project refuses Repair with the coded error the
            // backend's guard_mutation returns, never a zero result. `projectIsRemote`
            // is the mock's read-only-remote proxy, as in set_surface_elevation.
            if (openProjectNewerSchema !== null) {
              return Promise.reject({
                code: 'NEWER_FILE_EDIT_DISABLED',
                message:
                  `Repair integrity is disabled: this project was ` +
                  `saved by a newer version of Stalagmight (file format ${openProjectNewerSchema}) and ` +
                  `is open read-only. Update Stalagmight to edit it.`,
              } satisfies CommandError);
            }
            if (projectIsRemote) {
              return Promise.reject({
                code: 'EDIT_DISABLED',
                message: 'Repair integrity is disabled: this SpeleoDB project is open read-only. Acquire the lock to edit.',
              } satisfies CommandError);
            }
            const total = mockIntegrityIssues.length;
            const remaining = Math.min(mockIntegrityRemaining, total);
            const fixed = total - remaining;
            // Keep the trailing `remaining` issues as detect-only residue.
            mockIntegrityIssues = mockIntegrityIssues.slice(total - remaining);
            // `changed: false` is what the store read (falsy) while the mock omitted it:
            // the mock records no undo entry, so nothing marks the project dirty.
            return { fixed, remaining, changed: false, remote_link: remoteLink() } satisfies MockReply<'repair_project_integrity'>;
          }

          case 'remove_from_recent_projects':
            // Mock remove from recent - just return success
            console.log('[Mock IPC] remove_from_recent_projects called with:', args);
            return { warnings: [] } satisfies MockReply<'remove_from_recent_projects'>;

          case 'delete_project':
            // Mock destructive delete: like the backend, the file leaves the
            // recents list. Per-page state, so nothing leaks into another test.
            deletedProjectPaths.add(String(args?.path ?? ''));
            // `session_closed: false`: the mock never tears down the open session on a
            // delete (the reply before #576 C4 left the field out, which read as false).
            return { session_closed: false, warnings: [] } satisfies MockReply<'delete_project'>;

          case 'set_project_name_for_path': {
            const p = String(args?.path ?? '');
            const name = String(args?.name ?? '').trim();
            if (!name) return Promise.reject({ code: 'FAILED', message: 'Project name cannot be empty' } satisfies CommandError);
            recentNameOverrides[p] = name;
            return { warnings: [], remote_link: remoteLink() } satisfies MockReply<'set_project_name_for_path'>;
          }

          // Display settings (per-project) - uses in-memory storage for persistence testing
          case 'load_display_settings':
            // Return current display settings from in-memory storage
            return { ...mockDisplaySettings } satisfies MockReply<'load_display_settings'>;

          case 'save_display_setting': {
            // Persist setting to in-memory storage
            const key = args?.key as string;
            const value = args?.value as string;
            if (key && value !== undefined) {
              mockDisplaySettings[key] = value;
              console.log(`[Mock IPC] save_display_setting: ${key}=${value}`);
            }
            return null satisfies MockReply<'save_display_setting'>;
          }

          // Window plugin commands
          case 'plugin:window|set_title':
          case 'plugin:window|current':
            return { label: 'main' };

          // The real teardown the exit flow ends in (`useBeforeUnload`'s
          // closeWindowNow -> getCurrentWindow().destroy()). Counted, not just
          // swallowed, so a spec can assert that an UNGUARDED close actually
          // PROCEEDED - "no dialog appeared" alone also holds when the close
          // handler silently did nothing.
          case 'plugin:window|destroy':
            windowDestroyCount += 1;
            return null;

          // `performQuit()` asks for a close; the real backend prevents it and
          // re-emits `tauri://close-requested`, which the app turns into the
          // destroy above. Counted for the same reason.
          case 'plugin:window|close':
            windowCloseCount += 1;
            return null;

          // Plugin commands
          case 'plugin:dialog|open':
            // Count picker opens so a spec can prove the read-only-map guard (#243)
            // blocks Import before the picker even opens.
            dialogOpenCount += 1;
            // Return a mock file path for testing
            return '/mock/test-survey.dmp';
          case 'plugin:dialog|save':
            return '/mock/saved-project.stalx';

          // Path plugin: resolve a base directory to an absolute mock path.
          // Used by documentDir()/downloadDir() in the saveDialog() helper.
          case 'plugin:path|resolve_directory': {
            const baseDirs: Record<number, string> = {
              6: '/mock/documents', // BaseDirectory.Document
              7: '/mock/downloads', // BaseDirectory.Download
            };
            const dir = args?.directory as number | undefined;
            return (dir !== undefined && baseDirs[dir]) || '/mock/home';
          }

          case 'plugin:fs|read':
          case 'plugin:fs|readFile':
            return new Uint8Array([]);

          case 'plugin:fs|write':
          case 'plugin:fs|writeFile':
            return null;

          case 'plugin:fs|exists':
            return false;

          // The native UI zoom (`getCurrentWebview().setZoom`, src/utils/uiScale.ts): there is
          // no native webview to zoom in a browser; acknowledged so the scale is applied as set.
          case 'plugin:webview|set_webview_zoom':
            return null;

          // The native confirm (useBeforeUnload's tier-1 close question): declined, which is
          // what the unanswered call read as before #576 E3. A spec that needs a yes
          // overrides `plugin:dialog|confirm`.
          case 'plugin:dialog|confirm':
            return false;

          // Opener plugin commands
          case 'plugin:opener|open_url':
            console.log('[Mock IPC] open_url called with:', args);
            return undefined;

          case 'plugin:opener|reveal_item_in_dir':
            console.log('[Mock IPC] reveal_item_in_dir called with:', args);
            return undefined;

          case 'plugin:opener|open_path':
            console.log('[Mock IPC] open_path called with:', args);
            return undefined;

          // Export commands
          case 'export_csv':
            console.log('[Mock IPC] export_csv called with:', args);
            return null satisfies MockReply<'export_csv'>;

          case 'export_json':
            console.log('[Mock IPC] export_json called with:', args);
            return null satisfies MockReply<'export_json'>;

          // The Ariane writer's notes (#576 E3): none. What lands in the file is pinned by
          // the export crate's TML tests; a spec asserts the call and its path.
          case 'export_tml':
            return [] satisfies MockReply<'export_tml'>;

          // Dive-profile export (#299). Records the call so a spec can assert the plan INPUTS
          // reached the backend - the real command recomputes the reach field from them rather
          // than trusting a client-held one, so sending them is the contract under test.
          case 'export_dive_profile': {
            const win = window as unknown as Record<string, unknown>;
            const calls = (win.__MOCK_DIVE_PROFILE_EXPORTS__ as unknown[]) ?? [];
            calls.push({ path: args?.path, format: args?.format, request: args?.request });
            win.__MOCK_DIVE_PROFILE_EXPORTS__ = calls;
            return null satisfies MockReply<'export_dive_profile'>;
          }

          case 'render_dive_profile_text':
            return [
              'Mock Cave - planned dive profile',
              'Planned penetration profile from Stalagmight. NOT a decompression schedule.',
              '',
              '   Dist(m)   Depth(m)   Runtime      Gas(L)  Leg',
              '       0.0        0.0      0:00           0  in',
            ].join('\n') satisfies MockReply<'render_dive_profile_text'>;

          case 'preview_svg_export': {
            // Stick-map preview lives in the same backend command pipeline; the
            // mock returns a tiny but valid SVG so the preview component can
            // render without hitting Rust during e2e tests.
            const opts = args?.options as Record<string, unknown> | undefined;
            const threshold = (opts?.branching_threshold as number | undefined) ?? 0;
            // Encode the threshold in a data attribute so tests can verify
            // the preview re-fetches when the slider changes.
            return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" data-threshold="${threshold}"><rect width="100" height="100" fill="#ffffff"/><line x1="10" y1="50" x2="90" y2="50" stroke="#000000" stroke-width="1"/></svg>` satisfies MockReply<'preview_svg_export'>;
          }

          case 'export_image': {
            console.log('[Mock IPC] export_image called with:', args);
            // Store args for test assertions via __E2E_MOCKS__.getLastExportImageArgs()
            const exportOptions = args?.options as Record<string, unknown> | undefined;

            // Validate the slimmed ExportImageOptions shape (matches the new
            // backend struct): format + dpi + branching_threshold only.
            if (exportOptions) {
              if (exportOptions.format === undefined) {
                throw new Error('[Mock IPC] export_image: missing required option "format"');
              }
              if (exportOptions.dpi === undefined) {
                throw new Error('[Mock IPC] export_image: missing required option "dpi"');
              }
              if (exportOptions.branching_threshold === undefined) {
                throw new Error('[Mock IPC] export_image: missing required option "branching_threshold"');
              }
              const validFormats = ['png', 'svg', 'pdf'];
              if (!validFormats.includes(exportOptions.format as string)) {
                throw new Error(`[Mock IPC] export_image: invalid format "${exportOptions.format}", must be one of: ${validFormats.join(', ')}`);
              }
            }

            lastExportImageArgs = {
              path: args?.path,
              options: exportOptions ? { ...exportOptions } : null,
            };
            console.log('[Mock IPC] export_image options:', JSON.stringify(exportOptions));
            // Generate a unique loadingId for this export (matches ProgressEmitter behavior)
            const exportLoadingId = Date.now();
            // Emit loading-progress events using shared infrastructure format
            // Use longer delays to allow tests to observe progress states
            setTimeout(() => {
              window.__TAURI_INTERNALS__?.invoke('plugin:event|emit', {
                event: 'loading-progress',
                payload: {
                  loadingId: exportLoadingId,
                  phase: 'export_generating',
                  phaseIndex: 1,
                  phaseCount: 4,
                  current: null,
                  total: null,
                  overallPercent: 30,
                  isIndeterminate: true,
                },
              }).catch(() => {});
            }, 100);
            setTimeout(() => {
              window.__TAURI_INTERNALS__?.invoke('plugin:event|emit', {
                event: 'loading-progress',
                payload: {
                  loadingId: exportLoadingId,
                  phase: 'export_writing',
                  phaseIndex: 2,
                  phaseCount: 4,
                  current: 1,
                  total: 1,
                  overallPercent: 90,
                  isIndeterminate: false,
                },
              }).catch(() => {});
            }, 300);
            setTimeout(() => {
              window.__TAURI_INTERNALS__?.invoke('plugin:event|emit', {
                event: 'loading-progress',
                payload: {
                  loadingId: exportLoadingId,
                  phase: 'export_complete',
                  phaseIndex: 3,
                  phaseCount: 4,
                  current: 1,
                  total: 1,
                  overallPercent: 100,
                  isIndeterminate: false,
                },
              }).catch(() => {});
            }, 400);
            // Return after delay to allow progress events to be received and observed
            return new Promise(resolve => setTimeout(() => resolve(null), 500)) satisfies Promise<MockReply<'export_image'>>;
          }

          // Section and shot editing commands
          case 'update_shot': {
            console.log('[Mock IPC] update_shot called with:', args);
            // Mutate currentProject to support persistence testing
            // Note: Tauri invoke passes camelCase from JS side
            if (currentProject && args) {
              const sectionId = args.sectionId as number;
              const shotId = args.shotId as number;
              const updates = args.updates as Record<string, unknown>;
              const section = (currentProject.sections as Array<{ id: number; shots: Array<{ id: number } & Record<string, unknown>> }>)
                .find(s => s.id === sectionId);
              if (section) {
                const shot = section.shots.find(sh => sh.id === shotId);
                if (shot && updates) {
                  Object.assign(shot, updates);
                  console.log('[Mock IPC] update_shot: applied updates to shot', shotId, updates);
                }
              }
            }
            return { warnings: [], remote_link: remoteLink() } satisfies MockReply<'update_shot'>;
          }

          case 'delete_shot': {
            console.log('[Mock IPC] delete_shot called with:', args);
            // #310: a plain no-op response left every station index unchanged, so nothing
            // could ever be renumbered to test a live anchored pin against. Splice the shot
            // out in place - the real backend's `remove_shot_with_rewire` shortens the section
            // by one shot the same way, shifting every later station down by one index.
            if (currentProject && args) {
              const sectionId = args.sectionId as number;
              const shotId = args.shotId as number;
              const section = (
                currentProject.sections as Array<{ id: number; shots: Array<{ id: number }> }>
              ).find((s) => s.id === sectionId);
              if (section) {
                const idx = section.shots.findIndex((sh) => sh.id === shotId);
                if (idx >= 0) section.shots.splice(idx, 1);
              }
            }
            return { warnings: [], remote_link: remoteLink() } satisfies MockReply<'delete_shot'>;
          }

          case 'delete_last_shot_and_section':
            console.log('[Mock IPC] delete_last_shot_and_section called with:', args);
            return { warnings: [], remote_link: remoteLink() } satisfies MockReply<'delete_last_shot_and_section'>;

          case 'preview_delete_shot': {
            console.log('[Mock IPC] preview_delete_shot called with:', args);
            const sectionId = (args?.sectionId as number | undefined) ?? 1;
            return {
              removed_station: { section_id: sectionId, station_index: 0 },
              removed_merges: [
                {
                  station_a: { section_id: sectionId, station_index: 0 },
                  station_b: { section_id: sectionId, station_index: 1 },
                },
              ],
              removed_closures: [
                {
                  closure_id: 1,
                  station_a: { section_id: sectionId, station_index: 0 },
                  station_b: { section_id: sectionId, station_index: 2 },
                },
              ],
              replacement_merges: [],
              replacement_closure_updates: [],
              closure_to_merge: [],
              merge_rewire_skipped: false,
              closure_rewire_skipped: true,
              shift_blocked: false,
              shift_blocked_reasons: [],
            } satisfies MockReply<'preview_delete_shot'>;
          }

          case 'delete_shot_and_split':
            console.log('[Mock IPC] delete_shot_and_split called with:', args);
            // `section_id` is section B's: the id the backend's `next_section_id` would give
            // it. The mock does not model the split, so no section lands under that id.
            return { section_id: sectionCounter + 1, warnings: [], remote_link: remoteLink() } satisfies MockReply<'delete_shot_and_split'>;

          case 'preview_delete_shot_range': {
            console.log('[Mock IPC] preview_delete_shot_range called with:', args);
            const sectionId = (args?.sectionId as number | undefined) ?? 1;
            return {
              section_id: sectionId,
              start_pos: 1,
              end_pos: 2,
              kind: 'interior',
              removed_stations: [{ section_id: sectionId, station_index: 2 }],
              removed_merges: [
                {
                  station_a: { section_id: sectionId, station_index: 1 },
                  station_b: { section_id: sectionId, station_index: 2 },
                },
              ],
              removed_closures: [],
              replacement_merges: [],
              replacement_closure_updates: [],
              closure_to_merge: [],
              merge_rewire_skipped: false,
              closure_rewire_skipped: false,
              shift_blocked: false,
              shift_blocked_reasons: [],
              removed_datums: [],
              removed_comments: [],
            } satisfies MockReply<'preview_delete_shot_range'>;
          }

          case 'delete_shot_range_split':
            console.log('[Mock IPC] delete_shot_range_split called with:', args);
            // `section_id`: section B's, as in delete_shot_and_split (not modelled either).
            return { section_id: sectionCounter + 1, warnings: [], remote_link: remoteLink() } satisfies MockReply<'delete_shot_range_split'>;

          case 'delete_shot_range_shift':
            console.log('[Mock IPC] delete_shot_range_shift called with:', args);
            return { warnings: [], remote_link: remoteLink() } satisfies MockReply<'delete_shot_range_shift'>;

          case 'update_section': {
            console.log('[Mock IPC] update_section called with:', args);
            // Mutate currentProject to support persistence testing
            // Note: Tauri invoke passes camelCase from JS side
            if (currentProject && args) {
              const sectionId = args.sectionId as number;
              const updates = args.updates as Record<string, unknown>;
              const section = (currentProject.sections as Array<{ id: number } & Record<string, unknown>>)
                .find(s => s.id === sectionId);
              if (section && updates) {
                Object.assign(section, updates);
                console.log('[Mock IPC] update_section: applied updates to section', sectionId, updates);
              }
            }
            return { warnings: [], remote_link: remoteLink() } satisfies MockReply<'update_section'>;
          }

          case 'delete_section': {
            console.log('[Mock IPC] delete_section called with:', args);
            const sectionId = (args?.sectionId ?? args?.section_id) as number;
            if (currentProject && sectionId !== undefined) {
              currentProject.sections = (currentProject.sections as Array<{ id: number }>).filter(
                (s) => s.id !== sectionId,
              );
            }
            return { warnings: [], remote_link: remoteLink() } satisfies MockReply<'delete_section'>;
          }

          case 'reverse_section': {
            // [#576 E3] Canned: the request is acknowledged and the project is left as it
            // was. The transform (reciprocate-and-swap, depths, pitch, the optional L/R
            // swap), the anchor compensation and the mirroring of merges, closures, datums
            // and comments are the backend's, pinned in Rust (models project/reverse.rs and
            // project/mock_narrowing_tests.rs, core reverse_tests.rs). The reply echoes the
            // section's stored shot count, which is what the frontend mirrors its own
            // positional refs (plan pins, the distance origin) by.
            const sectionId = args?.sectionId as number;
            const section = (currentProject?.sections as Array<{ id: number; shots: unknown[] }> | undefined)?.find(
              (s) => s.id === sectionId,
            );
            if (!section) {
              return Promise.reject({ code: 'FAILED', message: `Section ${sectionId} not found` } satisfies CommandError);
            }
            return {
              reversed_sections: [{ section_id: sectionId, shot_count: section.shots.length }],
              warnings: [],
              remote_link: remoteLink(),
            } satisfies MockReply<'reverse_section'>;
          }

          case 'create_shot': {
            console.log('[Mock IPC] create_shot called with:', args);
            // Record calls for assertions (anchor args), mirroring execute_batch.
            const win = window as unknown as Record<string, unknown>;
            const existing = win.__MOCK_CREATE_SHOT_CALLS__ as unknown[] | undefined;
            const calls = Array.isArray(existing) ? existing : [];
            calls.push(args ?? null);
            win.__MOCK_CREATE_SHOT_CALLS__ = calls;
            // Mutate currentProject so the committed shot survives the store's
            // refresh: insert after/before the anchor shot (append by default)
            // with a section-monotonic id.
            // Note: Tauri invoke passes camelCase from JS side
            const sectionId = (args?.sectionId ?? args?.section_id) as number;
            const section = (currentProject?.sections as Array<{
              id: number;
              shots: Array<{ id: number } & Record<string, unknown>>;
            }> | undefined)?.find((s) => s.id === sectionId);
            if (!section) {
              return Promise.reject({ code: 'FAILED', message: `Section ${sectionId} not found` } satisfies CommandError);
            }
            const shotData = (args?.shot ?? {}) as Record<string, unknown>;
            const afterShotId = (args?.afterShotId ?? args?.after_shot_id ?? null) as number | null;
            const beforeShotId = (args?.beforeShotId ?? args?.before_shot_id ?? null) as number | null;
            const nextId =
              section.shots.reduce(
                (max, s) => Math.max(max, s.id),
                mockShotId(section.id as number, 0) - 1,
              ) + 1;
            // The real backend mints a uuid for every shot it creates (#576 NF-W3UI-1).
            const newShot = buildShot(nextId, shotData);
            let insertAt = section.shots.length;
            if (afterShotId !== null) {
              const i = section.shots.findIndex((s) => s.id === afterShotId);
              if (i >= 0) insertAt = i + 1;
            } else if (beforeShotId !== null) {
              const i = section.shots.findIndex((s) => s.id === beforeShotId);
              if (i >= 0) insertAt = i;
            }
            section.shots.splice(insertAt, 0, newShot);
            return { shot_id: nextId, warnings: [], remote_link: remoteLink() } satisfies MockReply<'create_shot'>;
          }

          case 'split_shot_at_distance': {
            // [#576 E3] Recorded (exact args) and acknowledged; the project is left as it
            // was. The split - the 0.01 m floor on both children, the interpolated depth,
            // the new head shot before the tail that keeps its id - is the backend's,
            // pinned by core tests.rs `test_split_shot_at_distance_happy_path` and
            // `test_split_shot_at_distance_rejects_invalid_distances`.
            const win = window as unknown as Record<string, unknown>;
            const existing = win.__MOCK_SPLIT_SHOT_CALLS__ as unknown[] | undefined;
            const calls = Array.isArray(existing) ? existing : [];
            calls.push(args ?? null);
            win.__MOCK_SPLIT_SHOT_CALLS__ = calls;
            const sectionId = args?.sectionId as number;
            const section = (currentProject?.sections as Array<{ id: number; shots: Array<{ id: number }> }> | undefined)?.find(
              (s) => s.id === sectionId,
            );
            if (!section) {
              return Promise.reject({ code: 'FAILED', message: `Section ${sectionId} not found` } satisfies CommandError);
            }
            // The id the backend would mint next in this section's band.
            const nextId =
              section.shots.reduce((max, s) => Math.max(max, s.id), mockShotId(section.id, 0) - 1) + 1;
            return { shot_id: nextId, warnings: [], remote_link: remoteLink() } satisfies MockReply<'split_shot_at_distance'>;
          }

          case 'merge_projects':
            console.log('[Mock IPC] merge_projects called with:', args);
            return { warnings: [] } satisfies MockReply<'merge_projects'>;

          case 'set_shot_kind': {
            console.log('[Mock IPC] set_shot_kind called with:', args);
            const sectionId = (args?.sectionId ?? args?.section_id) as number;
            const shotId = (args?.shotId ?? args?.shot_id) as number;
            const kind = (args?.kind ?? 'Normal') as string;
            if (currentProject && sectionId && shotId !== undefined) {
              const section = (
                currentProject.sections as Array<{ id: number; shots: Array<{ id: number }> }>
              ).find((s) => s.id === sectionId);
              if (section) {
                const shot = section.shots.find((s) => s.id === shotId);
                if (shot) {
                  (shot as { kind?: string }).kind = kind;
                }
              }
            }
            return { warnings: [], remote_link: remoteLink() } satisfies MockReply<'set_shot_kind'>;
          }

          // Raw sqlite browsing (data table fullscreen)
          case 'get_raw_table_names': {
            console.log('[Mock IPC] get_raw_table_names called');
            if (!currentProject) {
              throw new Error('No project database; save the project to browse raw data');
            }
            // Alphabetical, mirroring list_raw_table_names' ORDER BY name.
            return ['project', 'sections', 'shots', 'undo_stack'] satisfies MockReply<'get_raw_table_names'>;
          }

          case 'get_raw_table': {
            console.log('[Mock IPC] get_raw_table called with:', args);
            if (!currentProject) {
              throw new Error('No project database; save the project to browse raw data');
            }
            const project = currentProject;
            const table = (args?.table as string) ?? '';
            const limit = Math.min((args?.limit as number) ?? 1000, 10_000);
            const offset = (args?.offset as number) ?? 0;
            // Values are stringified "server-side" like Database::read_raw_table:
            // NULL → "NULL", blobs → a size placeholder like "<blob 4.2 KB>".
            const str = (value: unknown): string =>
              value === null || value === undefined ? 'NULL' : String(value);
            const rawSections = project.sections as Array<{
              id: number;
              name?: string | null;
              surveyor?: string | null;
              date?: string | null;
              color?: string | null;
              direction?: string;
              shots?: Array<{ id: number } & Record<string, unknown>>;
            }>;
            let columns: string[];
            let allRows: string[][];
            switch (table) {
              case 'project':
                columns = ['id', 'name', 'location', 'created_at', 'modified_at', 'schema_version', 'next_closure_id'];
                allRows = [[
                  '1',
                  project.name,
                  str(project.location),
                  project.created_at,
                  project.modified_at,
                  '7',
                  '1',
                ]];
                break;
              case 'sections':
                columns = ['id', 'name', 'surveyor', 'date', 'color', 'direction', 'quality', 'created_at'];
                allRows = rawSections.map((section) => [
                  String(section.id),
                  str(section.name),
                  str(section.surveyor),
                  str(section.date),
                  str(section.color),
                  section.direction ?? 'in',
                  '1',
                  project.created_at,
                ]);
                break;
              case 'shots':
                columns = [
                  'id', 'section_id', 'sequence_order', 'azimuth_in', 'azimuth_out', 'length',
                  'depth_in', 'depth_out', 'pitch_in', 'pitch_out', 'left_distance', 'right_distance',
                  'up_distance', 'down_distance', 'comment', 'kind', 'marker_index', 'temperature', 'uuid',
                ];
                allRows = rawSections.flatMap((section) =>
                  (section.shots ?? []).map((shot, index) => [
                    String(shot.id),
                    String(section.id),
                    String(index),
                    str(shot.azimuth_in),
                    str(shot.azimuth_out),
                    str(shot.length),
                    str(shot.depth_in),
                    str(shot.depth_out),
                    str(shot.pitch_in),
                    str(shot.pitch_out),
                    str(shot.left),
                    str(shot.right),
                    str(shot.up),
                    str(shot.down),
                    str(shot.comment),
                    shot.kind === 'Jump' ? '1' : shot.kind === 'Reference' ? '2' : '0',
                    str(shot.marker_index),
                    str(shot.temperature),
                    'NULL',
                  ])
                );
                break;
              case 'undo_stack':
                // BLOB columns render as size placeholders, like the real backend.
                columns = ['id', 'sequence', 'command_json', 'undo_data_json', 'executed_at'];
                allRows = [['1', '1', '<blob 1.2 KB>', '<blob 4.2 KB>', project.modified_at]];
                break;
              default:
                throw new Error(`Unknown table: ${table}`);
            }
            return {
              columns,
              rows: allRows.slice(offset, offset + limit),
              total_rows: allRows.length,
            } satisfies MockReply<'get_raw_table'>;
          }

          // Plugin: event system handlers for @tauri-apps/api/event
          case 'plugin:event|listen': {
            const event = args?.event as string;
            const handler = args?.handler as number;
            console.log('[Mock IPC] plugin:event|listen', event, 'handler:', handler);
            const listenerId = ++eventListenerId;
            eventListeners.set(listenerId, { handler, event });
            return listenerId;
          }

          case 'plugin:event|unlisten': {
            // Real Tauri API passes { event: eventName, eventId: listenerId }
            const eventId = args?.eventId as number;
            console.log('[Mock IPC] plugin:event|unlisten', 'eventId:', eventId);
            eventListeners.delete(eventId);
            return undefined;
          }

          case 'plugin:event|emit': {
            const event = args?.event as string;
            const payload = args?.payload;
            console.log('[Mock IPC] plugin:event|emit', event, payload);
            emitEvent(event, payload);
            return undefined;
          }

          case 'get_survey_geometry_for_file': {
            const filePath = args?.path as string;
            console.log('[Mock IPC] get_survey_geometry_for_file called for:', filePath);

            // Check if this path should simulate an error
            if (geometryErrorPaths.has(filePath)) {
              throw new Error(`Failed to load geometry for ${filePath}`);
            }

            // Check if this path should be delayed
            const delay = geometryDelayPaths.get(filePath);
            // Return a SurveyGeometry-conformant payload matching src/types/survey.ts
            const mockGeometry: MockReply<'get_survey_geometry_for_file'> = {
              origin: [-82.46, 24.93] as [number, number],
              shots: [
                { from: [-82.46, 24.93] as [number, number], to: [-82.4599, 24.9301] as [number, number], kind: 'Normal', section_id: 1 },
                { from: [-82.4599, 24.9301] as [number, number], to: [-82.4598, 24.9302] as [number, number], kind: 'Normal', section_id: 1 },
              ],
            };

            if (delay && delay > 0) {
              return new Promise((resolve) => setTimeout(() => resolve(mockGeometry), delay)) satisfies Promise<MockReply<'get_survey_geometry_for_file'>>;
            }

            return mockGeometry satisfies MockReply<'get_survey_geometry_for_file'>;
          }

          case 'take_pending_launch_files':
            // #424: no OS handed this browser-hosted app a file. Present so the
            // startup drain resolves to an empty list instead of falling through
            // to the `null` default, which `for (const p of null)` would throw on.
            return [] satisfies MockReply<'take_pending_launch_files'>;

          case 'take_unrecognised_shot_kinds':
            // #27: no unreadable kinds in the mocked fixtures. Present so the
            // post-load call resolves instead of throwing into the catch, which
            // would mask a real regression in that path.
            return [] satisfies MockReply<'take_unrecognised_shot_kinds'>;

          default: {
            for (const handle of familyHandlers) {
              const result = handle(cmd as MockCommandName, args);
              if (result !== UNHANDLED) return result;
            }
            // Answered on purpose with a fixed no-op (`./ipc/inert.ts`, each with its reason).
            if (Object.prototype.hasOwnProperty.call(inertCommands, cmd)) {
              return inertCommands[cmd]!.reply;
            }
            // [#576 E3-D2] No case answers this command: record it, and the auto fixture in
            // `../fixtures/coverage.ts` fails the test at teardown naming it. Still null here,
            // so the flow under test is not derailed mid-test by the mock itself.
            console.warn(`[Mock IPC] Unhandled command: ${cmd}`);
            unhandledCommands.push(cmd);
            const report = (window as unknown as Record<string, unknown>).__E2E_REPORT_UNMOCKED_IPC__;
            if (typeof report === 'function') (report as (command: string) => void)(cmd);
            return null;
          }
        }
      };
    })();

    // Mock the Tauri internals (Tauri 2.x API)
    const tauriInternals = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        return mockHandler(cmd, args);
      },
      transformCallback: (callback: () => void, once?: boolean) => {
        const id = Math.random().toString(36).substring(7);
        (window as unknown as Record<string, unknown>)[`_${id}`] = callback;
        return id;
      },
      convertFileSrc: (filePath: string, protocol?: string) => {
        return `asset://localhost/${filePath}`;
      },
      // sep()/delimiter() in @tauri-apps/api/path read these synchronously.
      plugins: {
        path: { sep: '/', delimiter: ':' },
      },
      metadata: {
        currentWindow: { label: 'main' },
        currentWebview: { label: 'main' },
      },
    };

    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = tauriInternals;

    // Mock window.__TAURI__ for older API usage
    (window as unknown as { __TAURI__: unknown }).__TAURI__ = {
      invoke: tauriInternals.invoke,
      convertFileSrc: tauriInternals.convertFileSrc,
      transformCallback: tauriInternals.transformCallback,
    };

    // Mock window API for getCurrentWindow
    (window as unknown as { __TAURI_INTERNALS__: typeof tauriInternals & { windows?: unknown } }).__TAURI_INTERNALS__.metadata = {
      currentWindow: {
        label: 'main',
      },
      currentWebview: {
        label: 'main',
      },
    };

    // Mock Tauri dialog plugin for dynamic import
    // This is needed because @tauri-apps/plugin-dialog uses its own invoke mechanism
    const mockDialogModule = {
      open: async (_options?: unknown) => {
        console.log('[Mock Dialog] open called');
        return '/mock/test-survey.dmp';
      },
      save: async (_options?: unknown) => {
        console.log('[Mock Dialog] save called');
        return '/mock/saved-project.stalx';
      },
      message: async (_message: string, _options?: unknown) => {
        console.log('[Mock Dialog] message called');
        return undefined;
      },
      ask: async (_message: string, _options?: unknown) => {
        console.log('[Mock Dialog] ask called');
        return true;
      },
      confirm: async (_message: string, _options?: unknown) => {
        console.log('[Mock Dialog] confirm called');
        return true;
      },
    };

    // Store the mock module for potential interception
    (window as unknown as Record<string, unknown>).__TAURI_DIALOG_MOCK__ = mockDialogModule;

    // Mock __TAURI_EVENT_PLUGIN_INTERNALS__ for @tauri-apps/api/event cleanup
    // The real Tauri event API calls unregisterListener on unlisten
    interface TauriEventPluginInternals {
      unregisterListener: (eventId: number) => void;
    }
    const tauriEventPluginInternals: TauriEventPluginInternals = {
      unregisterListener: (eventId: number) => {
        console.log('[Mock Event] unregisterListener:', eventId);
        eventListeners.delete(eventId);
      },
    };
    (window as unknown as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = tauriEventPluginInternals;

    // Mock event system for E2E tests (loading progress events, etc.)
    // This is wired to the plugin:event system so @tauri-apps/api/event.listen() works
    interface TauriEventMock {
      listen: (event: string, handler: (e: { payload: unknown }) => void) => Promise<() => void>;
      unlisten: (eventId: number) => void;
      emit: (event: string, payload: unknown) => void;
    }
    const tauriEventMock: TauriEventMock = {
      // Listen for events - returns an unlisten function
      listen: async (event: string, handler: (e: { payload: unknown }) => void) => {
        const listenerId = ++eventListenerId;
        const callbackId = `mock_cb_${listenerId}`;
        (window as unknown as Record<string, unknown>)[`_${callbackId}`] = handler;
        eventListeners.set(listenerId, { handler: callbackId as unknown as number, event });
        console.log('[Mock Event] listen:', event, 'listenerId:', listenerId);
        return () => {
          eventListeners.delete(listenerId);
          delete (window as unknown as Record<string, unknown>)[`_${callbackId}`];
        };
      },
      // Unlisten by eventId
      unlisten: (eventId: number) => {
        console.log('[Mock Event] unlisten:', eventId);
        eventListeners.delete(eventId);
      },
      // Emit events through the same system that @tauri-apps/api/event.listen uses
      emit: (event: string, payload: unknown) => {
        console.log('[Mock Event] emitEvent:', event, payload);
        emitEvent(event, payload);
      },
    };
    (window as unknown as Record<string, unknown>).__tauriEventMock = tauriEventMock;

    console.log('[Mock IPC] Tauri mocks installed');
  };

  // The page runs the core above with every command family, each serialized the way
  // addInitScript serializes a function.
  const families = MOCK_COMMAND_FAMILIES.map((family) => family.toString()).join(',\n');
  await page.addInitScript({
    content: `(${installTauriIpcMock.toString()})([${families}], ${buildMockShot.toString()}, ${JSON.stringify(INERT_COMMANDS)});`,
  });
}

export { createMockProject, createMockSection };
export type { MockProject, MockSection, MockShot };
