import { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve as pathResolve } from 'node:path';
import { createRequire } from 'node:module';

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
// encodes it — exercising the real decoder end-to-end with no
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

/**
 * Set up Tauri IPC mocks before the page loads.
 * This intercepts all Tauri API calls and returns mock data.
 */
export async function setupTauriMocks(page: Page): Promise<void> {
  // Inject the msgpack UMD bundle first so the load_project_full_binary
  // mock can encode its result the same way the real backend does.
  // Exposes `window.MessagePack` synchronously before any app JS runs.
  await page.addInitScript({ content: loadMsgpackUmd() });

  await page.addInitScript(() => {
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
      let sectionCounter = 0;

      // Cache mock state - tracks cache operations for verification
      // Use explicit types so providers can be empty and keys can be deleted
      interface MockProviderStats {
        tiles: bigint;
        bytes: bigint;
      }
      interface MockCacheStats {
        total_tiles: bigint;
        total_bytes: bigint;
        providers: Record<string, MockProviderStats>;
      }
      const defaultCacheStats: MockCacheStats = {
        total_tiles: 150n,
        total_bytes: 25600000n, // ~25MB
        providers: {
          esri: { tiles: 150n, bytes: 25600000n },
        },
      };
      let mockCacheStats: MockCacheStats = {
        total_tiles: defaultCacheStats.total_tiles,
        total_bytes: defaultCacheStats.total_bytes,
        providers: { ...defaultCacheStats.providers },
      };
      let mockNetworkStatus = true; // Online by default

      // Config override for testing config reload effects
      interface MockConfigOverrides {
        debug?: { map?: { show_hitboxes?: boolean; log_hit_detection?: boolean } };
        map?: {
          station?: { hit_area?: number };
          shot?: { hit_area?: number };
          animation?: { enabled?: boolean; duration?: number; point_zoom?: number };
        };
      }
      let mockConfigOverrides: MockConfigOverrides = {};

      // Expose reset function for tests via window
      (window as unknown as Record<string, unknown>).__MOCK_CACHE_RESET__ = () => {
        mockCacheStats = {
          total_tiles: defaultCacheStats.total_tiles,
          total_bytes: defaultCacheStats.total_bytes,
          providers: { ...defaultCacheStats.providers },
        };
        mockNetworkStatus = true;
      };
      (window as unknown as Record<string, unknown>).__MOCK_SET_NETWORK_STATUS__ = (status: boolean) => {
        mockNetworkStatus = status;
      };
      (window as unknown as Record<string, unknown>).__MOCK_GET_CACHE_STATS__ = () => mockCacheStats;

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
      let trackImportedFileCalls: Array<{ hash: string }> = [];
      let mergeStationCalls: Array<{
        stationA: { section_id: number; station_index: number };
        stationB: { section_id: number; station_index: number };
      }> = [];
      let unmergeStationPairCalls: Array<{
        stationA: { section_id: number; station_index: number };
        stationB: { section_id: number; station_index: number };
      }> = [];
      let mockOrphanPlacementSuggestions: unknown[] = [];
      let mockImportPlacementSuggestions: unknown[] = [];
      // Records execute_walls_import args (esp. selectedSurveys) so the Walls
      // import dialog spec can assert the select-all→null / explicit-index path.
      let wallsImportCalls: Array<Record<string, unknown>> = [];

      (window as unknown as Record<string, unknown>).__MOCK_SET_CHECK_DUPLICATE_RESULT__ = (result: boolean) => {
        mockCheckDuplicateResult = result;
      };
      (window as unknown as Record<string, unknown>).__MOCK_GET_WALLS_IMPORT_CALLS__ = () => [...wallsImportCalls];
      (window as unknown as Record<string, unknown>).__MOCK_RESET_WALLS_IMPORT_CALLS__ = () => {
        wallsImportCalls = [];
      };
      (window as unknown as Record<string, unknown>).__MOCK_GET_TRACK_IMPORTED_FILE_CALLS__ = () => [...trackImportedFileCalls];
      (window as unknown as Record<string, unknown>).__MOCK_RESET_TRACK_IMPORTED_FILE_CALLS__ = () => {
        trackImportedFileCalls = [];
      };
      (window as unknown as Record<string, unknown>).__MOCK_GET_MERGE_STATION_CALLS__ = () => [...mergeStationCalls];
      (window as unknown as Record<string, unknown>).__MOCK_RESET_MERGE_STATION_CALLS__ = () => {
        mergeStationCalls = [];
      };
      (window as unknown as Record<string, unknown>).__MOCK_GET_UNMERGE_STATION_PAIR_CALLS__ = () => [...unmergeStationPairCalls];
      (window as unknown as Record<string, unknown>).__MOCK_RESET_UNMERGE_STATION_PAIR_CALLS__ = () => {
        unmergeStationPairCalls = [];
      };
      // Records undo/redo invocations so specs can prove the shortcuts are inert in the
      // read-only workspaces (zero calls in Plan/Export, then one back in Survey).
      let undoRedoCalls: string[] = [];
      (window as unknown as Record<string, unknown>).__MOCK_GET_UNDO_REDO_CALLS__ = () => [...undoRedoCalls];
      (window as unknown as Record<string, unknown>).__MOCK_RESET_UNDO_REDO_CALLS__ = () => {
        undoRedoCalls = [];
      };
      (window as unknown as Record<string, unknown>).__MOCK_SET_ORPHAN_SUGGESTIONS__ = (suggestions: unknown[]) => {
        mockOrphanPlacementSuggestions = Array.isArray(suggestions) ? [...suggestions] : [];
      };
      (window as unknown as Record<string, unknown>).__MOCK_RESET_ORPHAN_SUGGESTIONS__ = () => {
        mockOrphanPlacementSuggestions = [];
      };
      (window as unknown as Record<string, unknown>).__MOCK_SET_IMPORT_PLACEMENT_SUGGESTIONS__ = (suggestions: unknown[]) => {
        mockImportPlacementSuggestions = Array.isArray(suggestions) ? [...suggestions] : [];
      };
      (window as unknown as Record<string, unknown>).__MOCK_RESET_IMPORT_PLACEMENT_SUGGESTIONS__ = () => {
        mockImportPlacementSuggestions = [];
      };

      // Expose config override for testing config reload
      (window as unknown as Record<string, unknown>).__MOCK_SET_CONFIG_OVERRIDES__ = (overrides: MockConfigOverrides) => {
        mockConfigOverrides = overrides;
      };
      (window as unknown as Record<string, unknown>).__MOCK_RESET_CONFIG_OVERRIDES__ = () => {
        mockConfigOverrides = {};
      };

      // Store saved config for persistence testing
      let savedConfig: Record<string, unknown> | null = null;
      (window as unknown as Record<string, unknown>).__MOCK_GET_SAVED_CONFIG__ = () => savedConfig;
      (window as unknown as Record<string, unknown>).__MOCK_RESET_SAVED_CONFIG__ = () => {
        savedConfig = null;
      };

      // Data-table view state persisted via update_data_table_view, merged
      // back into get_config's panels: the frontend re-syncs its in-memory
      // config via loadConfig() after each save, so without the merge a
      // saved view change would silently revert on the next remount.
      const mockDataTableView: Record<string, unknown> = {};

      // Station comments set via set_station_comment, keyed
      // "sectionId:stationIndex". get_project_state derives its station array
      // from the project's sections on every refresh, so comments must be
      // threaded back in from here or an edit would vanish on the next refresh.
      const mockStationComments: Record<string, string> = {};

      // Track last export_image call for test assertions
      let lastExportImageArgs: Record<string, unknown> | null = null;

      // Per-path project-name overrides applied by set_project_name_for_path,
      // so list_recent_projects reflects renames within a test.
      const recentNameOverrides: Record<string, string> = {};

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

      interface MockGpxPoint {
        latitude: number;
        longitude: number;
        elevation: number | null;
        time: string | null;
      }

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

      const toShot = (
        pointA: MockGpxPoint,
        pointB: MockGpxPoint,
        shotId: number,
        depthInverted: boolean
      ) => {
        const dLat = pointB.latitude - pointA.latitude;
        const dLon = pointB.longitude - pointA.longitude;
        const horizontalMeters = Math.max(0.1, Math.hypot(dLat, dLon) * 111_000);
        const azimuth = ((Math.atan2(dLon, dLat) * 180) / Math.PI + 360) % 360;
        const toDepth = (value: number | null): number => {
          if (value == null || !Number.isFinite(value)) return 0;
          return depthInverted ? -Math.abs(value) : -value;
        };
        return {
          id: shotId,
          azimuth_in: azimuth,
          azimuth_out: azimuth,
          length: Number(horizontalMeters.toFixed(2)),
          depth_in: toDepth(pointA.elevation),
          depth_out: toDepth(pointB.elevation),
          pitch_in: null,
          pitch_out: null,
          left: null,
          right: null,
          up: null,
          down: null,
          comment: null,
          is_reference: false,
          marker_index: null,
          temperature: null,
        };
      };

      return function mockCommand(
        cmd: string,
        args?: Record<string, unknown>
      ): unknown {
        // Skip logging for push_frontend_log to avoid infinite loop with console capture
        if (cmd !== 'push_frontend_log') {
          console.log(`[Mock IPC] Command: ${cmd}`, args);
        }

        const overrideMap = (window as unknown as Record<string, unknown>).__MOCK_IPC_OVERRIDES__ as
          | Record<string, unknown>
          | undefined;
        if (overrideMap && Object.prototype.hasOwnProperty.call(overrideMap, cmd)) {
          const override = overrideMap[cmd];
          if (override && typeof override === 'object' && '__throw' in override) {
            throw new Error(String((override as { __throw?: unknown }).__throw ?? 'Mock error'));
          }
          return override as unknown;
        }

        switch (cmd) {
          case 'create_project': {
            const name = (args?.name as string) ?? 'Untitled Project';
            const now = new Date().toISOString();
            sectionCounter = 0;
            currentProject = {
              id: 1,
              name,
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
            return { success: true, project: currentProject };
          }

          case 'update_project_settings': {
            // Per-project settings (#57): name + validation thresholds.
            if (currentProject) {
              if (typeof args?.name === 'string') currentProject.name = args.name;
              if (args?.validation) {
                (currentProject as Record<string, unknown>).validation = args.validation;
              }
            }
            return { success: true, project: currentProject };
          }

          case 'create_project_full': {
            // Consolidated create_project_full command for loading progress feature
            const name = (args?.name as string) ?? 'Untitled Project';
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
              project: currentProject,
              displaySettings: {
                showStations: true,
                showSectionNames: true,
                showStationLabels: false,
                showShotData: false,
                showReferenceShots: true,
                showZeroDatum: true,
                showGrid: false,
                showScaleBar: true,
                showSatellite: false,
                showDepthGradient: false,
                gridSpacing: 10,
              },
            };
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
                  { id: 1, azimuth_in: 45, azimuth_out: 50, length: 10, depth_in: 0, depth_out: -2, is_reference: false },
                  { id: 2, azimuth_in: 90, azimuth_out: 95, length: 15, depth_in: -2, depth_out: -5, is_reference: false },
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

            // Generate mock stations from sections
            const mockStations: Array<{
              station_ref: { section_id: number; station_index: number };
              coordinates: { x: number; y: number; z: number };
              is_zero_datum: boolean;
              gps_coordinates: { latitude: number; longitude: number; depth_reference: number } | null;
              merged_with: Array<{ section_id: number; station_index: number }>;
              closures_with: Array<{
                closure_id: bigint;
                station_ref: { section_id: number; station_index: number };
                via_station: { section_id: number; station_index: number } | null;
                is_transitive: boolean;
              }>;
            }> = [];

            // Collect all section IDs for merged station setup
            const sectionIds = (currentProject.sections as Array<{ id: number }>).map(s => s.id);
            const currentMerges = (currentProject.station_merges ?? []) as Array<{
              station_a: { section_id: number; station_index: number };
              station_b: { section_id: number; station_index: number };
            }>;
            const currentClosures = (currentProject.loop_closures ?? []) as Array<{
              id: bigint;
              station_a: { section_id: number; station_index: number };
              station_b: { section_id: number; station_index: number };
            }>;

            // Build zero_datums lookup for deriving is_zero_datum and gps_coordinates
            const loadDatums = (currentProject.zero_datums ?? []) as Array<{
              station_ref: { section_id: number; station_index: number };
              gps: { latitude: number; longitude: number; depth_reference: number };
            }>;

            for (const section of currentProject.sections as Array<{ id: number; shots: Array<{ depth_in?: number; depth_out?: number }> }>) {
              const shots = section.shots ?? [];
              const depths: number[] = [];
              if (shots.length > 0) {
                const firstDepth = shots[0]?.depth_in ?? 0;
                depths.push(firstDepth);
                for (const shot of shots) {
                  depths.push(shot.depth_out ?? depths[depths.length - 1] ?? 0);
                }
              } else {
                depths.push(0);
              }

              for (let i = 0; i < depths.length; i++) {
                const stationRef = { section_id: section.id, station_index: i };
                let mergedWith: Array<{ section_id: number; station_index: number }> = currentMerges
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

                const sectionIndex = sectionIds.indexOf(section.id);
                const isLastStation = i === depths.length - 1;
                const isFirstStation = i === 0;

                // Backward-compatible fallback used by legacy tests when no explicit merges are configured.
                if (mergedWith.length === 0 && currentMerges.length === 0) {
                  if (sectionIndex === 0 && isLastStation && sectionIds.length > 1) {
                    mergedWith = [{ section_id: sectionIds[1]!, station_index: 0 }];
                  }
                  if (sectionIndex === 1 && isFirstStation && sectionIds.length > 1) {
                    const firstSection = currentProject.sections[0] as { shots: unknown[] } | undefined;
                    const firstSectionLastStationIndex = firstSection ? (firstSection.shots?.length ?? 0) : 0;
                    mergedWith = [{ section_id: sectionIds[0]!, station_index: firstSectionLastStationIndex }];
                  }
                }

                // Derive is_zero_datum and gps_coordinates from project zero_datums
                const loadDatum = loadDatums.find(
                  (d) => d.station_ref.section_id === section.id && d.station_ref.station_index === i
                );
                const closuresWith = currentClosures.flatMap((closure) => {
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

                mockStations.push({
                  station_ref: stationRef,
                  coordinates: { x: i * 10, y: 0, z: depths[i] ?? 0 },
                  is_zero_datum: !!loadDatum,
                  gps_coordinates: loadDatum ? loadDatum.gps : null,
                  merged_with: mergedWith,
                  closures_with: closuresWith,
                });
              }
            }

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

            const shotLengths = defaultSections.flatMap((section) =>
              (section.shots ?? []).map((shot: { length?: number }) => shot.length ?? 0)
            );
            const totalLength = shotLengths.reduce((sum, length) => sum + length, 0);
            const depthValues = defaultSections.flatMap((section) =>
              (section.shots ?? []).flatMap((shot: { depth_in?: number; depth_out?: number }) => [
                shot.depth_in ?? 0,
                shot.depth_out ?? 0,
              ])
            );
            const minDepth = depthValues.length > 0 ? Math.min(...depthValues) : 0;
            const maxDepth = depthValues.length > 0 ? Math.max(...depthValues) : 0;
            const shotCount = defaultSections.reduce((count, section) => count + (section.shots?.length ?? 0), 0);

            // Return LoadProjectFullResult format
            return {
              loadingId,
              project: currentProject,
              stations: mockStations,
              stats: {
                section_count: currentProject.sections.length,
                shot_count: shotCount,
                total_length: totalLength,
                min_depth: minDepth,
                max_depth: maxDepth,
                station_count: mockStations.length,
                loop_count: 0,
                penetration_distance: totalLength,
              },
              warnings: [],
              displaySettings: {
                showStations: true,
                showSectionNames: true,
                showStationLabels: false,
                showShotData: false,
                showReferenceShots: true,
                showZeroDatum: true,
                showGrid: false,
                showScaleBar: true,
                showSatellite: false,
                showDepthGradient: false,
                gridSpacing: 10,
              },
            };
          }

          case 'load_project_full_binary': {
            // Mirror the binary IPC wire format that the Rust backend
            // emits from `src-tauri/src/core/load_binary.rs::encode`:
            // build the same JSON fixture the legacy `load_project_full`
            // case produces, pack shots / stations into Uint8Array byte
            // buffers, msgpack-encode the BinaryEnvelope, and return
            // bytes as a number array (the frontend's `Array.isArray`
            // fallback in loadProjectBinary.ts converts that to a real
            // Uint8Array). The msgpack UMD was injected by the wrapping
            // setupTauriMocks before this script ran, so
            // `window.MessagePack.encode` is available synchronously.
            const jsonResult = mockHandler('load_project_full', args) as {
              loadingId: number;
              project: {
                id?: number; name?: string; location?: string | null;
                created_at?: string; modified_at?: string; file_path?: string | null;
                next_section_id?: number; next_closure_id?: number;
                sections: Array<{
                  id: number; name?: string | null; surveyor?: string | null;
                  date?: string | null; color?: string; direction?: string; quality?: number;
                  shots?: Array<{
                    id: number; azimuth_in?: number; azimuth_out?: number;
                    length?: number; depth_in?: number; depth_out?: number;
                    pitch_in?: number | null; pitch_out?: number | null;
                    left?: number | null; right?: number | null;
                    up?: number | null; down?: number | null;
                    temperature?: number | null;
                    comment?: string | null;
                    is_reference?: boolean;
                    marker_index?: number | null;
                  }>;
                }>;
                station_merges?: unknown[]; zero_datums?: unknown[];
                loop_closures?: unknown[]; section_offsets?: Record<string, [number, number]>;
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
              stats: Record<string, unknown>;
              warnings: unknown[];
              displaySettings: Record<string, unknown>;
            };

            const totalShots = jsonResult.project.sections.reduce(
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

            for (const section of jsonResult.project.sections) {
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
                shotsFlags[shotCursor] = shot.is_reference ? 1 : 0;
                if (shot.comment) shotComments.push([shotCursor, shot.comment]);
                shotCursor++;
              }
              sectionsMeta.push({
                id: section.id,
                name: section.name ?? null,
                surveyor: section.surveyor ?? null,
                date: section.date ?? null,
                color: section.color ?? '#888888',
                direction: section.direction ?? 'Forward',
                quality: section.quality ?? 1.0,
                shot_offset,
                shot_count,
                next_shot_id: shot_offset + shot_count,
              });
            }

            const STATION_FLOAT_STRIDE = 24;
            const STATION_UINT_STRIDE = 8;
            const totalStations = jsonResult.stations.length;
            const stationsFloats = new Uint8Array(totalStations * STATION_FLOAT_STRIDE);
            const stationsUints = new Uint8Array(totalStations * STATION_UINT_STRIDE);
            const stationsFlags = new Uint8Array(totalStations);
            const stationsFloatsView = new DataView(stationsFloats.buffer);
            const stationsUintsView = new DataView(stationsUints.buffer);
            const stationGps: Array<[number, unknown]> = [];
            const stationMergedWith: Array<[number, unknown[]]> = [];
            const stationClosuresWith: Array<[number, unknown[]]> = [];
            const stationCommentsArr: Array<[number, string]> = [];

            jsonResult.stations.forEach((station, idx) => {
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
              // Bumped to 2 to match collab-mode's
              // `core/load_binary.rs::BINARY_FORMAT_VERSION` which
              // grew the `collab` field on the project header.  Keep
              // this in lockstep with `EXPECTED_VERSION` in
              // `src/utils/loadProjectBinary.ts`.
              version: 2,
              loading_id: jsonResult.loadingId,
              project_header: {
                name: jsonResult.project.name ?? 'Test Project',
                location: jsonResult.project.location ?? null,
                created_at: jsonResult.project.created_at ?? new Date().toISOString(),
                modified_at: jsonResult.project.modified_at ?? new Date().toISOString(),
                file_path: jsonResult.project.file_path ?? null,
                next_section_id: jsonResult.project.next_section_id
                  ?? (sectionsMeta.length + 1),
                next_closure_id: jsonResult.project.next_closure_id ?? 1,
                sections: sectionsMeta,
                station_merges: jsonResult.project.station_merges ?? [],
                zero_datums: jsonResult.project.zero_datums ?? [],
                loop_closures: jsonResult.project.loop_closures ?? [],
                section_offsets: Object.entries(jsonResult.project.section_offsets ?? {})
                  .map(([k, v]) => [Number(k), v]),
                station_offsets: [],
                station_comments_map: [],
                imported_file_hashes: [],
                imported_section_hashes: [],
                // Collab is off for the test fixture; loadProjectBinary
                // writes this through to `project.collab` and the
                // load-time detect path short-circuits on
                // `result.project.collab?.enabled`.
                collab: null,
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
              stats: jsonResult.stats,
              warnings: jsonResult.warnings,
              display_settings: jsonResult.displaySettings,
              frozen_shots: [],
            };

            const MessagePack = (window as unknown as {
              MessagePack?: { encode: (v: unknown) => Uint8Array };
            }).MessagePack;
            if (!MessagePack) {
              throw new Error(
                'load_project_full_binary mock: window.MessagePack missing — setupTauriMocks must inject the msgpack UMD',
              );
            }
            const bytes = MessagePack.encode(envelope);
            // Return as plain number[] so the frontend's
            // `Array.isArray` fallback converts to Uint8Array without
            // any extra cross-realm dance.
            return Array.from(bytes);
          }

          case 'load_project':
          case 'open_project': {
            projectPath = (args?.path as string) ?? null;
            if (!currentProject) {
              const now = new Date().toISOString();
              currentProject = {
                id: 1,
                name: 'Test Project',
                location: null,
                created_at: now,
                modified_at: now,
                file_path: projectPath,
                sections: [],
                station_merges: [],
                zero_datums: [],
                loop_closures: [],
                section_offsets: {},
              };
            }
            return { success: true, project: currentProject };
          }

          case 'save_project': {
            projectPath = (args?.path as string) ?? projectPath;
            if (currentProject && projectPath) {
              currentProject.file_path = projectPath;
            }
            return { success: true, saved_path: projectPath, error: null, warnings: [], section_ids: [] };
          }

          case 'close_project': {
            currentProject = null;
            projectPath = null;
            return { success: true };
          }

          case 'cancel_loading': {
            // Idempotent - does nothing but shouldn't error
            return undefined;
          }

          case 'get_recent_logs':
            // DebugDialog expects string[] log lines prefixed with a level.
            return ['INFO [mock] app started', 'DEBUG [mock] project loaded'];

          case 'get_project':
          case 'get_project_state': {
            // Generate mock stations from sections with merged_with data
            const mockStations: Array<{
              station_ref: { section_id: number; station_index: number };
              coordinates: { x: number; y: number; z: number };
              is_zero_datum: boolean;
              gps_coordinates: { latitude: number; longitude: number; depth_reference: number } | null;
              merged_with: Array<{ section_id: number; station_index: number }>;
              closures_with: Array<{
                closure_id: bigint;
                station_ref: { section_id: number; station_index: number };
                via_station: { section_id: number; station_index: number } | null;
                is_transitive: boolean;
              }>;
              comment?: string;
            }> = [];

            // Collect all section IDs for merged station setup
            const sectionIdList = (currentProject?.sections as Array<{ id: number }> ?? []).map(s => s.id);
            const stateMerges = (currentProject?.station_merges ?? []) as Array<{
              station_a: { section_id: number; station_index: number };
              station_b: { section_id: number; station_index: number };
            }>;
            const stateClosures = (currentProject?.loop_closures ?? []) as Array<{
              id: bigint;
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
                const sectionIndex = sectionIdList.indexOf(section.id);

                for (let i = 0; i <= shotCount; i++) {
                  const stationRef = { section_id: section.id, station_index: i };
                  let mergedWith: Array<{ section_id: number; station_index: number }> = stateMerges
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
                  const isLastStation = i === shotCount;
                  const isFirstStation = i === 0;

                  // Backward-compatible fallback used by legacy tests when no explicit merges are configured.
                  if (mergedWith.length === 0 && stateMerges.length === 0) {
                    if (sectionIndex === 0 && isLastStation && sectionIdList.length > 1) {
                      mergedWith = [{ section_id: sectionIdList[1]!, station_index: 0 }];
                    }
                    if (sectionIndex === 1 && isFirstStation && sectionIdList.length > 1) {
                      const firstSection = currentProject.sections[0] as { shots?: unknown[] } | undefined;
                      const firstSectionLastStationIndex = firstSection?.shots?.length ?? 0;
                      mergedWith = [{ section_id: sectionIdList[0]!, station_index: firstSectionLastStationIndex }];
                    }
                  }

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
                    closures_with: closuresWith,
                    ...(storedComment !== undefined ? { comment: storedComment } : {}),
                  });
                }
              }
            }

            const depthValues = mockStations.map((station) => station.coordinates.z);
            const minDepth = depthValues.length > 0 ? Math.min(...depthValues) : 0;
            const maxDepth = depthValues.length > 0 ? Math.max(...depthValues) : 0;
            const shotCount =
              currentProject?.sections.reduce(
                (count: number, section) =>
                  count + ((section as { shots?: Array<{ length?: number }> }).shots?.length ?? 0),
                0
              ) ?? 0;
            const totalLength =
              currentProject?.sections.reduce((total: number, section) => {
                const shots = (section as { shots?: Array<{ length?: number }> }).shots ?? [];
                return total + shots.reduce((sum, shot) => sum + (shot.length ?? 0), 0);
              }, 0) ?? 0;

            return {
              // Return a FRESH (deep-cloned) project each call, mirroring the real Tauri
              // IPC: the backend returns `project.clone()` serialized over IPC, so the
              // project AND every nested array (sections, zero_datums, loop_closures, …)
              // gets a new identity per call. The mock mutates those arrays in place
              // (e.g. sections.push in create_section, datums.push in set_zero_datum),
              // so returning the same reference froze #160's reference-keyed memos —
              // `useMemo([sections])` left the SectionsPanel empty even as fresh `stats`
              // showed the populated count. A deep clone keeps every consumer's
              // ref-identity check honest, not just the sections one. (Caused ~50
              // full-suite failures; smoke seeds once, so it never hit this.)
              project: currentProject ? structuredClone(currentProject) : currentProject,
              stations: mockStations,
              stats: {
                section_count: currentProject?.sections.length ?? 0,
                shot_count: shotCount,
                total_length: totalLength,
                min_depth: minDepth,
                max_depth: maxDepth,
                station_count: mockStations.length,
                loop_count: 0,
                penetration_distance: totalLength,
              },
              frozen_shots: [],
            };
          }

          case 'get_adjusted_stations': {
            // Closure-adjusted geometry view. The mock has no real least-squares
            // solver, so the adjusted geometry is identical to measured: reuse the
            // station array get_project_state builds.
            const state = mockHandler('get_project_state', args) as
              | { stations?: unknown[] }
              | null;
            return state?.stations ?? [];
          }

          case 'get_station_distances_from': {
            // Distance-gradient field (#34). No real graph in the mock — synthesize
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
            };
          }

          case 'compute_gas_reach_field': {
            // Gas reachable-frontier field (#38). No real graph in the mock —
            // synthesize a field from each station's mock x-coordinate (origin at
            // x=0) so the overlay + legend + turn markers have finite values to
            // render. Diver/cylinders/gasConfig inputs are ignored; the budget is a
            // fixed plausible value so far-enough stations fall outside it.
            const state = mockHandler('get_project_state', args) as
              | {
                  stations?: Array<{
                    station_ref: { section_id: number; station_index: number };
                    coordinates: { x: number; y: number; z: number };
                  }>;
                }
              | null;
            const stations = state?.stations ?? [];
            const budget_litres = 1500;
            const gas_to_reach = stations.map((s) => Math.abs(s.coordinates.x) * 20);
            const reachable = gas_to_reach.map((g) => g <= budget_litres);
            let max_reachable_gas = 0;
            for (let i = 0; i < gas_to_reach.length; i += 1) {
              if (reachable[i] && gas_to_reach[i] > max_reachable_gas) {
                max_reachable_gas = gas_to_reach[i];
              }
            }
            // Turn frontier: a reachable station whose next (by array order) is not
            // reachable — enough for the marker layer to render in the smoke test.
            const turn_frontier = stations
              .filter((_s, i) => reachable[i] && i + 1 < stations.length && !reachable[i + 1])
              .map((s) => s.station_ref);
            // Staged-strategy drops + the readout gauges (Half-Minus). Mirror the backend: only the
            // staged strategies carry drops, and only when the rig actually has enough Stage
            // cylinders (else it falls back to All-thirds). The endpoint, when given + reachable, is
            // the route target (else the deepest reachable station). Exact math is unit-tested in
            // Rust; the mock just produces plausible, shape-correct values for the UI wiring.
            const gasConfig = (args?.gasConfig ?? {}) as {
              default_reserve?: string;
              reserve_profile?: { stage_reserve_bar?: number };
              conservative_tank_gas?: boolean;
            };
            const cylinders = (args?.cylinders ?? []) as Array<{
              role?: string;
              fill_bar?: number;
              water_volume_l?: number;
              rated_pressure_bar?: number;
            }>;
            const requested = gasConfig.default_reserve ?? 'all_thirds';
            const stageCyls = cylinders.filter((c) => c.role === 'stage');
            const required = requested === 'two_stage' ? 2 : requested === 'one_stage' ? 1 : 0;
            const effective = stageCyls.length >= required ? requested : 'all_thirds';
            const dropCount = effective === 'two_stage' ? 2 : effective === 'one_stage' ? 1 : 0;
            const reserve = gasConfig.reserve_profile?.stage_reserve_bar ?? 30;

            const reachableRefs = stations
              .filter((_s, i) => reachable[i])
              .map((s) => s.station_ref);
            let deepestIdx = -1;
            let deepestGas = -1;
            for (let i = 0; i < gas_to_reach.length; i += 1) {
              if (reachable[i] && gas_to_reach[i] > deepestGas) {
                deepestGas = gas_to_reach[i];
                deepestIdx = i;
              }
            }
            const endpoint = (args?.endpoint ?? null) as {
              section_id: number;
              station_index: number;
            } | null;
            const endpointReachable =
              endpoint != null &&
              reachableRefs.some(
                (r) =>
                  r.section_id === endpoint.section_id && r.station_index === endpoint.station_index,
              );
            const targetRef = endpointReachable
              ? endpoint
              : deepestIdx >= 0
                ? stations[deepestIdx].station_ref
                : null;
            const final_turn_ref = targetRef;
            const stage_drop_refs = dropCount > 0 ? reachableRefs.slice(1, 1 + dropCount) : [];
            // Route legs to the target (consecutive reachable stations; the real graph path is
            // exercised in Rust). is_jump stays false — the seeded e2e sections carry no jumps.
            const route =
              targetRef != null
                ? reachableRefs
                    .slice(0, -1)
                    .map((from, i) => ({ from, to: reachableRefs[i + 1], is_jump: false }))
                : [];

            // Route physical metrics (#236) over the route's stations, in order (origin→turnaround),
            // derived from the route legs the mock returns — so it mirrors the backend's route_refs
            // CHAIN, not the full reachable set. NOTE: the seeded e2e cave is a single linear section
            // with no merge/closure ties, so this is an approximation for the linear seed, not a
            // re-implementation of the backend's tie-aware shortest path (exact math is Rust-tested).
            const coordByRef = new Map(
              stations.map((s) => [
                `${s.station_ref.section_id}:${s.station_ref.station_index}`,
                s.coordinates,
              ]),
            );
            const routeRefsOrdered =
              route.length > 0
                ? [route[0].from, ...route.map((leg) => leg.to)]
                : targetRef != null
                  ? [targetRef]
                  : [];
            const routePts = routeRefsOrdered
              .map((r) => coordByRef.get(`${r.section_id}:${r.station_index}`))
              .filter((c): c is { x: number; y: number; z: number } => c != null);
            let route_line_length_m = 0;
            let route_max_depth_m: number | null = null;
            let route_avg_depth_m: number | null = null;
            if (routePts.length > 0) {
              route_max_depth_m = Math.max(...routePts.map((c) => c.z));
              let depthLenSum = 0;
              for (let i = 1; i < routePts.length; i += 1) {
                const a = routePts[i - 1];
                const b = routePts[i];
                const seg = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
                route_line_length_m += seg;
                depthLenSum += seg * 0.5 * (a.z + b.z);
              }
              route_avg_depth_m =
                route_line_length_m > 0 ? depthLenSum / route_line_length_m : routePts[0].z;
            }

            const backCyls = cylinders.filter((c) => c.role === 'back_gas');
            const sumWv = backCyls.reduce((s, c) => s + (c.water_volume_l ?? 0), 0);
            const frac = effective === 'two_stage' ? 1 / 6 : effective === 'one_stage' ? 1 / 4 : 1 / 3;
            const backgas_turn_bar =
              sumWv > 0
                ? Math.max(
                    0,
                    (backCyls.reduce((s, c) => s + (c.fill_bar ?? 0) * (c.water_volume_l ?? 0), 0) /
                      sumWv) *
                      (1 - frac),
                  )
                : null;
            const stage_drop_bars =
              dropCount > 0
                ? stageCyls.slice(0, dropCount).map((c) => {
                    const fill = c.fill_bar ?? 0;
                    const rated = c.rated_pressure_bar ?? fill;
                    const basis =
                      gasConfig.conservative_tank_gas !== false ? Math.min(fill, rated) : fill;
                    return Math.min(basis, 0.5 * (basis + reserve));
                  })
                : [];
            return {
              station_refs: stations.map((s) => s.station_ref),
              gas_to_reach,
              reachable,
              turn_frontier,
              max_reachable_gas,
              budget_litres,
              route,
              stage_drop_refs,
              final_turn_ref,
              backgas_turn_bar,
              stage_drop_bars,
              route_line_length_m,
              route_max_depth_m,
              route_avg_depth_m,
            };
          }

          case 'get_along_line_distance': {
            // Ruler along-line distance (#26). No real survey graph in the mock —
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
            return { along_line: 12.34, path_shots, path_stations };
          }

          case 'create_section': {
            sectionCounter++;
            const rawShots = Array.isArray(args?.shots) ? (args?.shots as Array<Record<string, unknown>>) : [];
            const shots = rawShots.map((shot, index) => ({
              id: index + 1,
              azimuth_in: (shot.azimuth_in as number) ?? 0,
              azimuth_out: (shot.azimuth_out as number) ?? 0,
              length: (shot.length as number) ?? 0,
              depth_in: (shot.depth_in as number) ?? 0,
              depth_out: (shot.depth_out as number) ?? 0,
              pitch_in: (shot.pitch_in as number | null | undefined) ?? null,
              pitch_out: (shot.pitch_out as number | null | undefined) ?? null,
              left: (shot.left as number | null | undefined) ?? null,
              right: (shot.right as number | null | undefined) ?? null,
              up: (shot.up as number | null | undefined) ?? null,
              down: (shot.down as number | null | undefined) ?? null,
              comment: (shot.comment as string | null | undefined) ?? null,
              is_reference: (shot.is_reference as boolean | undefined) ?? false,
              marker_index: (shot.marker_index as number | null | undefined) ?? null,
              temperature: (shot.temperature as number | null | undefined) ?? null,
            }));
            const section = {
              id: sectionCounter,
              name: (args?.name as string) ?? `Section ${sectionCounter}`,
              surveyor: 'Test Surveyor',
              date: new Date().toISOString().split('T')[0],
              color: '#3b82f6',
              shots,
            };
            currentProject?.sections.push(section);
            return { success: true, section, section_id: sectionCounter, warnings: [], error: null };
          }

          case 'import_sections': {
            console.log('[Mock IPC] import_sections called with:', args);
            const rawSections = Array.isArray(args?.sections) ? (args?.sections as Array<Record<string, unknown>>) : [];
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
              const shots = rawShots.map((shot, index) => ({
                id: index + 1,
                azimuth_in: (shot.azimuth_in as number) ?? 0,
                azimuth_out: (shot.azimuth_out as number) ?? 0,
                length: (shot.length as number) ?? 0,
                depth_in: (shot.depth_in as number) ?? 0,
                depth_out: (shot.depth_out as number) ?? 0,
                pitch_in: (shot.pitch_in as number | null | undefined) ?? null,
                pitch_out: (shot.pitch_out as number | null | undefined) ?? null,
                left: (shot.left as number | null | undefined) ?? null,
                right: (shot.right as number | null | undefined) ?? null,
                up: (shot.up as number | null | undefined) ?? null,
                down: (shot.down as number | null | undefined) ?? null,
                comment: (shot.comment as string | null | undefined) ?? null,
                is_reference: (shot.is_reference as boolean | undefined) ?? false,
                marker_index: (shot.marker_index as number | null | undefined) ?? null,
                temperature: (shot.temperature as number | null | undefined) ?? null,
              }));
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
            return {
              success: true,
              warnings: [],
              error: null,
              section_ids: sectionIds,
              ...(sectionIds[0] != null ? { section_id: sectionIds[0] } : {}),
              sections: importedSections,
            };
          }

          case 'execute_walls_import':
            // Record the import args (selectedSurveys, includeSplays, …) for
            // assertions, then return a one-section success so the dialog runs
            // its "imported" exit path (not the "nothing imported" branch).
            wallsImportCalls.push({ ...(args ?? {}) });
            return {
              success: true,
              warnings: [],
              error: null,
              section_ids: [1],
              section_id: 1,
            };

          // File hash tracking for duplicate detection
          case 'calculate_file_hash':
            // Return a mock SHA256 hash based on path for consistency
            return `mock_hash_${(args?.path as string)?.split('/').pop() ?? 'unknown'}`;

          case 'check_duplicate_import':
            // Configurable via __MOCK_SET_CHECK_DUPLICATE_RESULT__
            return mockCheckDuplicateResult;

          case 'track_imported_file':
            console.log('[Mock IPC] track_imported_file called with:', args);
            trackImportedFileCalls.push({ hash: (args?.hash as string) ?? '' });
            return { success: true };

          case 'parse_gpx': {
            return buildMockGpxFile(args?.path as string | undefined);
          }

          case 'execute_gpx_import': {
            const importWaypoints = (args?.importWaypoints as boolean | undefined) ?? false;
            const importTracks = (args?.importTracks as boolean | undefined) ?? false;
            const importRoutes = (args?.importRoutes as boolean | undefined) ?? false;
            const depthInverted = (args?.depthInverted as boolean | undefined) ?? false;
            const filePath = (args?.path as string | undefined) ?? null;
            const sectionPlacements = (Array.isArray(args?.sectionPlacements) ? args?.sectionPlacements : []) as Array<{
              section_index?: number;
              placement?: {
                type?: string;
                station_index?: number;
                coordinates?: { latitude: number; longitude: number; depth_reference: number };
              };
              name?: string | null;
              color?: string;
            }>;

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

            const gpxFile = buildMockGpxFile(filePath);
            const placementMap = new Map<number, typeof sectionPlacements[number]>();
            for (const placement of sectionPlacements) {
              const sectionIndex = placement.section_index;
              if (typeof sectionIndex === 'number') {
                placementMap.set(sectionIndex, placement);
              }
            }

            const createdSectionIds: number[] = [];
            let backendSectionIndex = 0;

            const appendSection = (
              name: string,
              shots: Array<Record<string, unknown>>,
              color: string,
              datum:
                | {
                    stationIndex: number;
                    gps: { latitude: number; longitude: number; depth_reference: number };
                  }
                | null
            ) => {
              sectionCounter += 1;
              const sectionId = sectionCounter;
              const section = {
                id: sectionId,
                name,
                surveyor: 'GPX Import',
                date: new Date().toISOString().split('T')[0] ?? '',
                color,
                direction: 'in',
                shots,
              };
              currentProject?.sections.push(section);
              createdSectionIds.push(sectionId);
              if (datum) {
                (currentProject?.zero_datums as Array<{
                  station_ref: { section_id: number; station_index: number };
                  gps: { latitude: number; longitude: number; depth_reference: number };
                }>).push({
                  station_ref: { section_id: sectionId, station_index: datum.stationIndex },
                  gps: datum.gps,
                });
              }
            };

            if (importWaypoints) {
              gpxFile.waypoints.forEach((wpt, index) => {
                appendSection(
                  wpt.name ?? `Waypoint ${index + 1}`,
                  [],
                  '#4a90d9',
                  {
                    stationIndex: 0,
                    gps: {
                      latitude: wpt.latitude,
                      longitude: wpt.longitude,
                      depth_reference: 0,
                    },
                  }
                );
                backendSectionIndex += 1;
              });
            }

            if (importTracks) {
              gpxFile.tracks.forEach((track, trackIndex) => {
                track.segments.forEach((segment, segmentIndex) => {
                  const shots = segment.points.slice(1).map((point, idx) =>
                    toShot(segment.points[idx]!, point, idx + 1, depthInverted)
                  );
                  const placement = placementMap.get(backendSectionIndex);
                  const placementDatum =
                    placement?.placement?.type === 'zero_datum' && placement.placement.coordinates
                      ? {
                          stationIndex: placement.placement.station_index ?? 0,
                          gps: placement.placement.coordinates,
                        }
                      : segment.points[0]
                        ? {
                            stationIndex: 0,
                            gps: {
                              latitude: segment.points[0].latitude,
                              longitude: segment.points[0].longitude,
                              depth_reference: 0,
                            },
                          }
                        : null;

                  appendSection(
                    placement?.name ??
                      track.name ??
                      `Track ${trackIndex + 1}${track.segments.length > 1 ? ` - Seg ${segmentIndex + 1}` : ''}`,
                    shots,
                    placement?.color ?? '#3b82f6',
                    placementDatum
                  );
                  backendSectionIndex += 1;
                });
              });
            }

            if (importRoutes) {
              gpxFile.routes.forEach((route, routeIndex) => {
                const shots = route.points.slice(1).map((point, idx) =>
                  toShot(route.points[idx]!, point, idx + 1, depthInverted)
                );
                const placement = placementMap.get(backendSectionIndex);
                const placementDatum =
                  placement?.placement?.type === 'zero_datum' && placement.placement.coordinates
                    ? {
                        stationIndex: placement.placement.station_index ?? 0,
                        gps: placement.placement.coordinates,
                      }
                    : route.points[0]
                      ? {
                          stationIndex: 0,
                          gps: {
                            latitude: route.points[0].latitude,
                            longitude: route.points[0].longitude,
                            depth_reference: 0,
                          },
                        }
                      : null;

                appendSection(
                  placement?.name ?? route.name ?? `Route ${routeIndex + 1}`,
                  shots,
                  placement?.color ?? '#22c55e',
                  placementDatum
                );
                backendSectionIndex += 1;
              });
            }

            if (currentProject) {
              currentProject.modified_at = new Date().toISOString();
            }

            return {
              success: true,
              warnings: [],
              error: null,
              section_ids: createdSectionIds,
              ...(createdSectionIds[0] != null ? { section_id: createdSectionIds[0] } : {}),
            };
          }

          case 'import_dmp':
          case 'parse_dmp': {
            return {
              version: 5,
              sections: [
                {
                  name: 'Main Passage',
                  direction: 'in',
                  date: new Date().toISOString().split('T')[0],
                  shots: [
                    {
                      shot_type: 'Standard',
                      heading_in: 45,
                      heading_out: 50, // both forward readings
                      length: 10.5,
                      depth_in: -2.0,
                      depth_out: -2.5,
                      pitch_in: 0,
                      pitch_out: 0,
                      left: 1.5,
                      right: 2.3,
                      up: 3.0,
                      down: 0.8,
                      temperature: 18.5,
                      hour: 10,
                      minute: 30,
                      second: 0,
                      marker_index: 0,
                      comment: 'Entrance point with good visibility',
                    },
                    {
                      shot_type: 'Standard',
                      heading_in: 90,
                      heading_out: 95, // both forward readings
                      length: 15.2,
                      depth_in: -2.5,
                      depth_out: -5.0,
                      pitch_in: 5,
                      pitch_out: 5,
                      left: 0.5,
                      right: 0.7,
                      up: 1.2,
                      down: 1.5,
                      temperature: 18.3,
                      hour: 10,
                      minute: 35,
                      second: 0,
                      marker_index: 1,
                      // No comment - testing undefined case
                    },
                    {
                      shot_type: 'Standard',
                      heading_in: 135,
                      heading_out: 140, // both forward readings
                      length: 8.0,
                      depth_in: -5.0,
                      depth_out: -3.0,
                      pitch_in: -10,
                      pitch_out: -10,
                      left: 4.2,
                      right: 3.8,
                      up: 5.0,
                      down: 2.0,
                      temperature: 18.0,
                      hour: 10,
                      minute: 40,
                      second: 0,
                      marker_index: 2,
                      comment: 'Large chamber with stalactites on ceiling, white formations visible on right wall',
                    },
                  ],
                },
                {
                  name: 'Side Tunnel',
                  direction: 'out',
                  date: new Date().toISOString().split('T')[0],
                  shots: [
                    {
                      shot_type: 'Standard',
                      heading_in: 270,
                      heading_out: 275, // both forward readings
                      length: 5.0,
                      depth_in: -3.0,
                      depth_out: -4.0,
                      pitch_in: 0,
                      pitch_out: 0,
                      left: 0,
                      right: 0,
                      up: 0,
                      down: 0,
                      temperature: 17.5,
                      hour: 11,
                      minute: 0,
                      second: 0,
                      marker_index: 0,
                      comment: 'Narrow restriction',
                    },
                    {
                      shot_type: 'Standard',
                      heading_in: 280,
                      heading_out: 285, // both forward readings
                      length: 7.5,
                      depth_in: -4.0,
                      depth_out: -6.0,
                      pitch_in: 0,
                      pitch_out: 0,
                      left: 0,
                      right: 0,
                      up: 0,
                      down: 0,
                      temperature: 17.2,
                      hour: 11,
                      minute: 5,
                      second: 0,
                      marker_index: 1,
                      // No comment
                    },
                  ],
                },
                {
                  name: 'Mixed LRUD Section',
                  direction: 'in',
                  date: new Date().toISOString().split('T')[0],
                  shots: [
                    {
                      shot_type: 'Standard',
                      heading_in: 180,
                      heading_out: 185, // both forward readings
                      length: 12.0,
                      depth_in: -1.0,
                      depth_out: -2.0,
                      pitch_in: 8.0,
                      pitch_out: 0,
                      left: 2.5,
                      right: 0,
                      up: 4.0,
                      down: 0,
                      temperature: 19.0,
                      hour: 12,
                      minute: 0,
                      second: 0,
                      marker_index: 0,
                    },
                    {
                      shot_type: 'Standard',
                      heading_in: 190,
                      heading_out: 195, // both forward readings
                      length: 9.0,
                      depth_in: -2.0,
                      depth_out: -3.0,
                      pitch_in: 0,
                      pitch_out: 12.0,
                      left: 0,
                      right: 1.8,
                      up: 0,
                      down: 3.2,
                      temperature: 18.8,
                      hour: 12,
                      minute: 5,
                      second: 0,
                      marker_index: 1,
                    },
                    {
                      shot_type: 'Standard',
                      heading_in: 200,
                      heading_out: 205, // both forward readings
                      length: 50.5,
                      depth_in: -3.0,
                      depth_out: -8.0,
                      pitch_in: 6.0,
                      pitch_out: 10.0,
                      left: 10.5,
                      right: 15.2,
                      up: 20.0,
                      down: 8.5,
                      temperature: 18.5,
                      hour: 12,
                      minute: 10,
                      second: 0,
                      marker_index: 2,
                    },
                  ],
                },
                {
                  name: 'Undefined LRUD Section',
                  direction: 'in',
                  date: new Date().toISOString().split('T')[0],
                  shots: [
                    {
                      shot_type: 'Standard',
                      heading_in: 90,
                      heading_out: 95, // both forward readings
                      length: 6.0,
                      depth_in: -2.0,
                      depth_out: -3.0,
                      pitch_in: 0,
                      pitch_out: 0,
                      // LRUD fields completely omitted (undefined)
                      temperature: 18.0,
                      hour: 14,
                      minute: 0,
                      second: 0,
                      marker_index: 0,
                    },
                    {
                      shot_type: 'Standard',
                      heading_in: 100,
                      heading_out: 105, // both forward readings
                      length: 8.0,
                      depth_in: -3.0,
                      depth_out: -4.0,
                      pitch_in: 0,
                      pitch_out: 0,
                      // Partial LRUD - only left and up defined
                      left: 1.2,
                      up: 2.5,
                      // right and down are undefined
                      temperature: 17.8,
                      hour: 14,
                      minute: 5,
                      second: 0,
                      marker_index: 1,
                    },
                  ],
                },
                {
                  name: 'Empty Section',
                  direction: 'in',
                  date: new Date().toISOString().split('T')[0],
                  shots: [],
                },
                {
                  name: 'Validation Test Section',
                  direction: 'in',
                  date: new Date().toISOString().split('T')[0],
                  shots: [
                    {
                      // Shot with warning: length exceeds max (50.0m)
                      shot_type: 'Standard',
                      heading_in: 45,
                      heading_out: 46,
                      length: 55.0,
                      depth_in: -1.0,
                      depth_out: -2.0,
                      pitch_in: 0,
                      pitch_out: 0,
                      left: 1.0,
                      right: 1.0,
                      up: 1.0,
                      down: 1.0,
                      temperature: 18.0,
                      hour: 15,
                      minute: 0,
                      second: 0,
                      marker_index: 0,
                      comment: 'Long shot - exceeds max length',
                    },
                    {
                      // Shot with error: azimuth out of range
                      shot_type: 'Standard',
                      heading_in: 400,
                      heading_out: 45,
                      length: 10.0,
                      depth_in: -2.0,
                      depth_out: -3.0,
                      pitch_in: 0,
                      pitch_out: 0,
                      left: 1.0,
                      right: 1.0,
                      up: 1.0,
                      down: 1.0,
                      temperature: 18.0,
                      hour: 15,
                      minute: 5,
                      second: 0,
                      marker_index: 1,
                      comment: 'Invalid azimuth - out of range',
                    },
                    {
                      // Shot with warning: excessive depth change
                      shot_type: 'Standard',
                      heading_in: 90,
                      heading_out: 91,
                      length: 8.0,
                      depth_in: -3.0,
                      depth_out: -15.0,
                      pitch_in: 0,
                      pitch_out: 0,
                      left: 1.0,
                      right: 1.0,
                      up: 1.0,
                      down: 1.0,
                      temperature: 18.0,
                      hour: 15,
                      minute: 10,
                      second: 0,
                      marker_index: 2,
                      comment: 'Excessive depth change',
                    },
                    {
                      // Shot with warning: LRUD exceeds max
                      shot_type: 'Standard',
                      heading_in: 120,
                      heading_out: 121,
                      length: 6.0,
                      depth_in: -15.0,
                      depth_out: -16.0,
                      pitch_in: 0,
                      pitch_out: 0,
                      left: 60.0,
                      right: 1.0,
                      up: 1.0,
                      down: 1.0,
                      temperature: 18.0,
                      hour: 15,
                      minute: 15,
                      second: 0,
                      marker_index: 3,
                      comment: 'Large LRUD value',
                    },
                  ],
                },
              ],
            };
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
            return { success: true };
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
            for (const command of commands) {
              if (command?.type === 'update_shot') {
                mockHandler('update_shot', {
                  sectionId: command.section_id,
                  shotId: command.shot_id,
                  updates: command.updates,
                });
              }
            }
            return { success: true };
          }

          case 'check_merge_connectivity': {
            // Mock connectivity check
            // Default: not connected but merge allowed (opens merge dialog)
            // Tests can override via __MOCK_SET_CONNECTIVITY__
            console.log('[Mock IPC] check_merge_connectivity called with:', args);
            const mockConnectivity = (window as unknown as Record<string, unknown>).__MOCK_CONNECTIVITY_RESULT__ as {
              connected: boolean;
              preview: unknown | null;
            } | undefined;
            if (mockConnectivity) {
              return mockConnectivity;
            }
            return { connected: false, preview: null, can_merge: true, reason: null };
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
              return { success: false, error: 'Missing closure stations' };
            }

            if (currentProject) {
              const loopClosures = currentProject.loop_closures as Array<{
                id: bigint;
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

              const alreadyExists = loopClosures.some((closure) => {
                const direct =
                  closure.station_a.section_id === stationA.section_id &&
                  closure.station_a.station_index === stationA.station_index &&
                  closure.station_b.section_id === stationB.section_id &&
                  closure.station_b.station_index === stationB.station_index;
                const reverse =
                  closure.station_a.section_id === stationB.section_id &&
                  closure.station_a.station_index === stationB.station_index &&
                  closure.station_b.section_id === stationA.section_id &&
                  closure.station_b.station_index === stationA.station_index;
                return direct || reverse;
              });
              if (alreadyExists) {
                return { success: false, error: 'A loop closure already exists between these stations.' };
              }

              const maxExistingId = loopClosures.reduce(
                (maxId, closure) => (closure.id > maxId ? closure.id : maxId),
                0n
              );
              const nextId = maxExistingId + 1n;

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

            return { success: true };
          }

          case 'remove_loop_closure': {
            console.log('[Mock IPC] remove_loop_closure called with:', args);
            const closureIdRaw = args?.closureId ?? args?.closure_id;
            if (closureIdRaw === undefined || closureIdRaw === null) {
              return { success: false, error: 'Missing closure ID' };
            }
            const closureId =
              typeof closureIdRaw === 'bigint'
                ? closureIdRaw
                : typeof closureIdRaw === 'number'
                  ? BigInt(closureIdRaw)
                  : typeof closureIdRaw === 'string'
                    ? BigInt(closureIdRaw)
                    : null;
            if (closureId === null) {
              return { success: false, error: 'Invalid closure ID' };
            }

            if (!currentProject) {
              return { success: false, error: 'No project open' };
            }

            const loopClosures = currentProject.loop_closures as Array<{ id: bigint }>;
            const closureIndex = loopClosures.findIndex((closure) => closure.id === closureId);
            if (closureIndex < 0) {
              return { success: false, error: 'Loop closure not found' };
            }

            loopClosures.splice(closureIndex, 1);
            return { success: true };
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

                const removedPairs: Array<{
                  station_a: { section_id: number; station_index: number };
                  station_b: { section_id: number; station_index: number };
                }> = [];

                for (let i = stationMerges.length - 1; i >= 0; i -= 1) {
                  const merge = stationMerges[i]!;
                  const touchesStation =
                    (merge.station_a.section_id === stationRef.section_id && merge.station_a.station_index === stationRef.station_index) ||
                    (merge.station_b.section_id === stationRef.section_id && merge.station_b.station_index === stationRef.station_index);
                  if (touchesStation) {
                    removedPairs.push(merge);
                    stationMerges.splice(i, 1);
                  }
                }

                if (removedPairs.length > 0 && Array.isArray(currentProject.loop_closures)) {
                  const loopClosures = currentProject.loop_closures as Array<Record<string, unknown>>;
                  currentProject.loop_closures = loopClosures.filter((closure) => {
                    const stationA = closure.station_a as { section_id: number; station_index: number } | undefined;
                    const stationB = closure.station_b as { section_id: number; station_index: number } | undefined;
                    if (!stationA || !stationB) {
                      return true;
                    }

                    const matchesRemovedPair = removedPairs.some((pair) => {
                      const direct =
                        pair.station_a.section_id === stationA.section_id &&
                        pair.station_a.station_index === stationA.station_index &&
                        pair.station_b.section_id === stationB.section_id &&
                        pair.station_b.station_index === stationB.station_index;
                      const reverse =
                        pair.station_b.section_id === stationA.section_id &&
                        pair.station_b.station_index === stationA.station_index &&
                        pair.station_a.section_id === stationB.section_id &&
                        pair.station_a.station_index === stationB.station_index;
                      return direct || reverse;
                    });

                    return !matchesRemovedPair;
                  });
                }
              }
            }
            return { success: true };

          case 'unmerge_station_pair': {
            console.log('[Mock IPC] unmerge_station_pair called with:', args);
            const stationA = (args?.stationA ?? args?.station_a) as { section_id: number; station_index: number } | undefined;
            const stationB = (args?.stationB ?? args?.station_b) as { section_id: number; station_index: number } | undefined;
            if (!stationA || !stationB) {
              return { success: false, error: 'Missing station pair' };
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

              if (matchIndex >= 0) {
                stationMerges.splice(matchIndex, 1);

                if (Array.isArray(currentProject.loop_closures)) {
                  const loopClosures = currentProject.loop_closures as Array<Record<string, unknown>>;
                  currentProject.loop_closures = loopClosures.filter((closure) => {
                    const closureA = closure.station_a as { section_id: number; station_index: number } | undefined;
                    const closureB = closure.station_b as { section_id: number; station_index: number } | undefined;
                    if (!closureA || !closureB) {
                      return true;
                    }
                    const direct =
                      closureA.section_id === stationA.section_id &&
                      closureA.station_index === stationA.station_index &&
                      closureB.section_id === stationB.section_id &&
                      closureB.station_index === stationB.station_index;
                    const reverse =
                      closureA.section_id === stationB.section_id &&
                      closureA.station_index === stationB.station_index &&
                      closureB.section_id === stationA.section_id &&
                      closureB.station_index === stationA.station_index;
                    return !(direct || reverse);
                  });
                }
                return { success: true };
              }
            }

            return { success: false, error: 'Stations are not directly merged' };
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
            return { success: true };
          }

          case 'move_section': {
            // Record the dispatched offset (mirrors move_segment/move_station) so
            // commit-assertion tests can check the offset that reached the backend.
            console.log('[Mock IPC] move_section called with:', args);
            const win = window as unknown as Record<string, unknown>;
            const calls = (win.__MOCK_MOVE_CALLS__ as unknown[]) ?? [];
            calls.push({ command: 'move_section', args: args ?? null });
            win.__MOCK_MOVE_CALLS__ = calls;
            return { success: true };
          }

          case 'move_station': {
            console.log('[Mock IPC] move_station called with:', args);
            const win = window as unknown as Record<string, unknown>;
            const calls = (win.__MOCK_MOVE_CALLS__ as unknown[]) ?? [];
            calls.push({ command: 'move_station', args: args ?? null });
            win.__MOCK_MOVE_CALLS__ = calls;
            return { success: true };
          }

          case 'move_shot':
            // Mock move shot - just return success
            console.log('[Mock IPC] move_shot called with:', args);
            return { success: true };

          case 'get_anchored_section_ids':
            // Return section IDs that have zero datums
            console.log('[Mock IPC] get_anchored_section_ids called');
            if (currentProject) {
              const datums = (currentProject.zero_datums ?? []) as Array<{
                station_ref: { section_id: number; station_index: number };
              }>;
              const anchoredIds = [...new Set(datums.map(d => d.station_ref.section_id))];
              anchoredIds.sort((a, b) => a - b);
              return anchoredIds;
            }
            return [];

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
            return { success: true };
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
            return { success: true };
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
            return { success: true };
          }

          case 'check_section_hashes': {
            const hashes = (Array.isArray(args?.hashes) ? args?.hashes : []) as string[];
            return hashes.map(() => false);
          }

          case 'suggest_import_placement':
            return [];

          case 'suggest_all_import_placements':
            return [...mockImportPlacementSuggestions];

          case 'suggest_orphan_placements':
            return [...mockOrphanPlacementSuggestions];

          case 'get_segment_geometry':
            return {
              sections: [
                {
                  section_id: (args?.sectionId as number | undefined) ?? 1,
                  color: '#4a90d9',
                  shot_lines: [[[0, 0], [10, 0]]],
                },
              ],
            };

          case 'undo':
          case 'redo':
            undoRedoCalls.push(cmd);
            return { success: true };

          case 'can_undo':
            return false;

          case 'can_redo':
            return false;

          case 'get_undo_state':
            return { can_undo: false, can_redo: false };

          case 'get_config':
            // Return saved config if available (for testing persistence),
            // overlaying any view state stored via update_data_table_view.
            if (savedConfig) {
              return {
                ...savedConfig,
                panels: {
                  ...((savedConfig.panels as Record<string, unknown> | undefined) ?? {}),
                  ...mockDataTableView,
                },
              };
            }
            return {
              general: {
                auto_save: true,
                auto_save_interval_seconds: 30,
                recent_projects_max: 20,
                recent_projects: [],
                undo_history_limit: 100,
                undo_persist_limit: 20,
                shortcut_feedback: 'non_obvious',
                locale: 'system',
                number_format: 'locale',
                date_format: 'locale',
                splash_screen: false,
                // Keep onboarding disabled in E2E to avoid overlay interception.
                onboarding_enabled: false,
                onboarding_completed_flows: [],
              },
              units: {
                length: 'meters',
                depth: 'meters',
                angle: 'degrees',
                decimal_precision: { length: 1, coordinates: 2, depth: 1, azimuth: 1, inclination: 1, gps: 6 },
              },
              gas: {
                units: 'metric',
                default_reserve: 'all_thirds',
                reserve_profile: {
                  stage_reserve_bar: 30,
                  recalc_hold_stage2_bar: 100,
                  recalc_hold_stage1_bar: 70,
                },
                swim_speed_m_per_min: 10,
                survey_speed_m_per_min: null,
                survey_rmv_multiplier: 1,
                stressed_rmv_multiplier: 1.5,
                jump_rmv_multiplier: 1.5,
                conservative_tank_gas: true,
                dpv: null,
              },
              display: {
                default_background: '#1a1a2e',
                grid_color: '#333366',
                grid_spacing: 10,
                font_size: 12,
                font_color: '#f5f5f5',
                depth_gradient: {
                  enabled: false,
                  shallow_color: '#00bfff',
                  deep_color: '#ff4444',
                  shallow_depth: 0.0,
                  deep_depth: 50.0,
                },
              },
              section_colors: {
                palette: ['#4ecdc4', '#ff6b6b', '#95e1d3', '#f38181', '#aa96da', '#fcbad3', '#a8d8ea', '#ffcb77'],
              },
              map: {
                satellite_provider: 'esri',
                satellite_enabled: false,
                satellite_gps_origin: {
                  latitude: 24.55,
                  longitude: -81.78,
                },
                zoom_default: 15,
                zoom_min: 1,
                zoom_max: 22,
                zoom_step: 1.0,
                controls: {
                  pan_speed: 1.0,
                  zoom_speed: 1.0,
                  invert_scroll: false,
                },
                station: {
                  radius: 4.0,
                  hit_area: 10.0,
                  hover_radius: 6.0,
                  selection_radius: 5.0,
                },
                shot: {
                  width: 2.0,
                  hit_area: 8.0,
                  hover_width: 4.0,
                  selection_width: 3.0,
                },
                snap: {
                  threshold: 10.0,
                  enabled_draw: true,
                  enabled_merge: true,
                  enabled_measure: true,
                },
                animation: {
                  enabled: true,
                  duration: 300,
                  point_zoom: 18,
                },
              },
              validation: {
                warn_shot_length_min: 0.1,
                warn_shot_length_max: 50.0,
                warn_depth_change_per_shot_max: 10.0,
                warn_azimuth_deviation_max: 30.0,
                azimuth_diff_threshold: 20.0,
                pitch_diff_threshold: 5.0,
              },
              closure_adjustment: {
                base_sigma_length_m: 0.05,
                base_sigma_azimuth_deg: 1.0,
                base_sigma_depth_m: 0.05,
                transit_vertical_mode: 'ignore',
                sequential_distribution_default: 'ProportionalByLength',
              },
              export: {
                default_image_format: 'png',
                default_dpi: 300,
                default_include_satellite: true,
                default_include_grid: false,
                default_include_labels: true,
              },
              logging: {
                level: 'info',
                max_directory_size_mb: 128,
              },
              shortcuts: {
                // File
                import_dmp: ['Ctrl+I'],
                export: ['Ctrl+E'],
                new_file: ['Ctrl+N'],
                open_file: ['Ctrl+O'],
                save: ['Ctrl+S'],
                save_as: ['Ctrl+Shift+S'],
                // Tools
                select: ['S'],
                pan: ['P'],
                zoom: ['Z'],
                merge: ['M'],
                measure: ['R'],
                move_segment: ['V'],
                move_shot: ['G'],
                move_station: ['T'],
                // Edit
                undo: ['Ctrl+Z'],
                redo: ['Ctrl+Y', 'Ctrl+Shift+Z'],
                // View
                toggle_depth_gradient: ['Shift+D'],
                toggle_grid: ['Shift+G'],
                toggle_satellite: ['B'],
                toggle_station_labels: ['L'],
                toggle_shot_labels: ['Shift+L'],
                toggle_section_labels: ['Ctrl+L'],
                fit_to_bounds: ['F'],
                zoom_in: ['Equal', 'Plus'],
                zoom_out: ['Minus'],
                // Panels (tests use Ctrl+ prefix)
                toggle_sections_panel: ['Ctrl+1'],
                toggle_detail_panel: ['Ctrl+2'],
                toggle_data_table: ['Ctrl+3'],
              },
              panels: {
                sections_panel_width: 250,
                detail_panel_width: 300,
                data_table_height: 200,
                data_table_shot_column_order: [],
                data_table_shot_hidden_columns: ['section_id', 'shot_id'],
                data_table_azimuth_mode: 'avg',
                data_table_inclination_mode: 'off',
                data_table_station_column_order: [],
                data_table_station_hidden_columns: ['_x', '_y', '_lat', '_long'],
                // Mirror the Rust serde defaults for the reveal state so initPanels
                // reads concrete values (side panels pinned open, data closed),
                // matching the real config shape get_config returns.
                sections_panel_open: true,
                sections_panel_mode: 'pin',
                detail_panel_open: true,
                detail_panel_mode: 'pin',
                data_table_open: false,
                data_table_mode: 'pin',
                ...mockDataTableView,
              },
              cache: {
                tile_cache_enabled: true,
                tile_cache_max_mb: 500,
                tile_ttl_days: 30,
              },
              debug: {
                map: {
                  show_hitboxes: false,
                  log_hit_detection: false,
                },
              },
              global_view: {
                fps_threshold: 30,
                tolerance: 0.5,
                throttle_tolerance: 1.0,
              },
              appearance: {
                theme: 'dark',
                day_color_theme: 'light',
                night_color_theme: 'cave',
              },
              syntactic_highlighting: {
                level: 'full',
                preset: 'default',
                overrides: {},
              },
              // SpeleoDB config block: the real get_config always returns this
              // (Rust SpeleoDbConfig::default), and SpeleoStatusButton reads
              // config.speleodb.poll_interval_seconds on every project-view mount -
              // omitting it here makes config.speleodb undefined and crashes the view.
              speleodb: {
                endpoint: null,
                email: null,
                token_fallback: 'session_only',
                insecure_http: false,
                poll_interval_seconds: 60,
              },
            };

          case 'update_config':
            // Mock update_config - store config and return success
            console.log('[Mock IPC] update_config called with:', args);
            savedConfig = args?.config as Record<string, unknown> | undefined ?? null;
            return { success: true };

          case 'update_data_table_view': {
            console.log('[Mock IPC] update_data_table_view called with:', args);
            // Record calls for assertions (debounced view-persistence payloads).
            const win = window as unknown as Record<string, unknown>;
            const existing = win.__MOCK_DATA_TABLE_VIEW_CALLS__ as unknown[] | undefined;
            const calls = Array.isArray(existing) ? existing : [];
            calls.push(args ?? null);
            win.__MOCK_DATA_TABLE_VIEW_CALLS__ = calls;
            // Mirror the Rust impl's partial-update semantics: only provided
            // fields overwrite the stored view state (merged into get_config's
            // panels above).
            const columnOrder = (args?.columnOrder ?? args?.column_order) as string[] | undefined;
            if (columnOrder != null) mockDataTableView.data_table_shot_column_order = columnOrder;
            const hiddenColumns = (args?.hiddenColumns ?? args?.hidden_columns) as string[] | undefined;
            if (hiddenColumns != null) mockDataTableView.data_table_shot_hidden_columns = hiddenColumns;
            const azimuthMode = (args?.azimuthMode ?? args?.azimuth_mode) as string | undefined;
            if (azimuthMode != null) mockDataTableView.data_table_azimuth_mode = azimuthMode;
            const inclinationMode = (args?.inclinationMode ?? args?.inclination_mode) as string | undefined;
            if (inclinationMode != null) mockDataTableView.data_table_inclination_mode = inclinationMode;
            const stationColumnOrder = (args?.stationColumnOrder ?? args?.station_column_order) as string[] | undefined;
            if (stationColumnOrder != null) mockDataTableView.data_table_station_column_order = stationColumnOrder;
            const stationHiddenColumns = (args?.stationHiddenColumns ?? args?.station_hidden_columns) as string[] | undefined;
            if (stationHiddenColumns != null) mockDataTableView.data_table_station_hidden_columns = stationHiddenColumns;
            return null; // Tauri serializes () as null
          }

          case 'reload_config': {
            // Return saved config if available (for testing persistence)
            if (savedConfig) {
              return savedConfig;
            }
            // Return mock config with any test overrides applied
            // This allows tests to modify config values via __MOCK_SET_CONFIG_OVERRIDES__
            const baseConfig = {
              general: {
                auto_save: true,
                auto_save_interval_seconds: 30,
                recent_projects_max: 20,
                recent_projects: [],
                undo_history_limit: 100,
                undo_persist_limit: 20,
                shortcut_feedback: 'non_obvious',
                locale: 'system',
                number_format: 'locale',
                date_format: 'locale',
                splash_screen: false,
                // Keep onboarding disabled in E2E to avoid overlay interception.
                onboarding_enabled: false,
                onboarding_completed_flows: [],
              },
              units: {
                length: 'meters',
                depth: 'meters',
                angle: 'degrees',
                decimal_precision: { length: 1, coordinates: 2, depth: 1, azimuth: 1, inclination: 1, gps: 6 },
              },
              gas: {
                units: 'metric',
                default_reserve: 'all_thirds',
                reserve_profile: {
                  stage_reserve_bar: 30,
                  recalc_hold_stage2_bar: 100,
                  recalc_hold_stage1_bar: 70,
                },
                swim_speed_m_per_min: 10,
                survey_speed_m_per_min: null,
                survey_rmv_multiplier: 1,
                stressed_rmv_multiplier: 1.5,
                jump_rmv_multiplier: 1.5,
                conservative_tank_gas: true,
                dpv: null,
              },
              display: {
                default_background: '#1a1a2e',
                grid_color: '#333366',
                grid_spacing: 10,
                font_size: 12,
                font_color: '#f5f5f5',
                depth_gradient: {
                  enabled: false,
                  shallow_color: '#00bfff',
                  deep_color: '#ff4444',
                  shallow_depth: 0.0,
                  deep_depth: 50.0,
                },
              },
              section_colors: {
                palette: ['#4ecdc4', '#ff6b6b', '#95e1d3', '#f38181', '#aa96da', '#fcbad3', '#a8d8ea', '#ffcb77'],
              },
              map: {
                satellite_provider: 'esri',
                satellite_enabled: false,
                satellite_gps_origin: {
                  latitude: 24.55,
                  longitude: -81.78,
                },
                zoom_default: 15,
                zoom_min: 1,
                zoom_max: 22,
                zoom_step: 1.0,
                controls: {
                  pan_speed: 1.0,
                  zoom_speed: 1.0,
                  invert_scroll: false,
                },
                station: {
                  radius: 4.0,
                  hit_area: mockConfigOverrides.map?.station?.hit_area ?? 10.0,
                  hover_radius: 6.0,
                  selection_radius: 5.0,
                },
                shot: {
                  width: 2.0,
                  hit_area: mockConfigOverrides.map?.shot?.hit_area ?? 8.0,
                  hover_width: 4.0,
                  selection_width: 3.0,
                },
                snap: {
                  threshold: 10.0,
                  enabled_draw: true,
                  enabled_merge: true,
                  enabled_measure: true,
                },
                animation: {
                  enabled: mockConfigOverrides.map?.animation?.enabled ?? true,
                  duration: mockConfigOverrides.map?.animation?.duration ?? 300,
                  point_zoom: mockConfigOverrides.map?.animation?.point_zoom ?? 18,
                },
              },
              validation: {
                warn_shot_length_min: 0.1,
                warn_shot_length_max: 50.0,
                warn_depth_change_per_shot_max: 10.0,
                warn_azimuth_deviation_max: 30.0,
                azimuth_diff_threshold: 20.0,
                pitch_diff_threshold: 5.0,
              },
              closure_adjustment: {
                base_sigma_length_m: 0.05,
                base_sigma_azimuth_deg: 1.0,
                base_sigma_depth_m: 0.05,
                transit_vertical_mode: 'ignore',
                sequential_distribution_default: 'ProportionalByLength',
              },
              export: {
                default_image_format: 'png',
                default_dpi: 300,
                default_include_satellite: true,
                default_include_grid: false,
                default_include_labels: true,
              },
              logging: {
                level: 'info',
                max_directory_size_mb: 128,
              },
              shortcuts: {
                // File
                import_dmp: ['Ctrl+I'],
                export: ['Ctrl+E'],
                new_file: ['Ctrl+N'],
                open_file: ['Ctrl+O'],
                save: ['Ctrl+S'],
                save_as: ['Ctrl+Shift+S'],
                // Tools
                select: ['S'],
                pan: ['P'],
                zoom: ['Z'],
                merge: ['M'],
                measure: ['R'],
                move_segment: ['V'],
                move_shot: ['G'],
                move_station: ['T'],
                // Edit
                undo: ['Ctrl+Z'],
                redo: ['Ctrl+Y', 'Ctrl+Shift+Z'],
                // View
                toggle_depth_gradient: ['Shift+D'],
                toggle_grid: ['Shift+G'],
                toggle_satellite: ['B'],
                toggle_station_labels: ['L'],
                toggle_shot_labels: ['Shift+L'],
                toggle_section_labels: ['Ctrl+L'],
                fit_to_bounds: ['F'],
                zoom_in: ['Equal', 'Plus'],
                zoom_out: ['Minus'],
                // Panels (tests use Ctrl+ prefix)
                toggle_sections_panel: ['Ctrl+1'],
                toggle_detail_panel: ['Ctrl+2'],
                toggle_data_table: ['Ctrl+3'],
              },
              panels: {
                sections_panel_width: 250,
                detail_panel_width: 300,
                data_table_height: 200,
                data_table_shot_column_order: [],
                data_table_shot_hidden_columns: ['section_id', 'shot_id'],
                data_table_azimuth_mode: 'avg',
                data_table_inclination_mode: 'off',
                data_table_station_column_order: [],
                data_table_station_hidden_columns: ['_x', '_y', '_lat', '_long'],
                // Mirror the Rust serde defaults for the reveal state so initPanels
                // reads concrete values (side panels pinned open, data closed),
                // matching the real config shape get_config returns.
                sections_panel_open: true,
                sections_panel_mode: 'pin',
                detail_panel_open: true,
                detail_panel_mode: 'pin',
                data_table_open: false,
                data_table_mode: 'pin',
                ...mockDataTableView,
              },
              cache: {
                tile_cache_enabled: true,
                tile_cache_max_mb: 500,
                tile_ttl_days: 30,
              },
              debug: {
                map: {
                  show_hitboxes: mockConfigOverrides.debug?.map?.show_hitboxes ?? false,
                  log_hit_detection: mockConfigOverrides.debug?.map?.log_hit_detection ?? false,
                },
              },
              global_view: {
                fps_threshold: 30,
                tolerance: 0.5,
                throttle_tolerance: 1.0,
              },
              appearance: {
                theme: 'dark',
                day_color_theme: 'light',
                night_color_theme: 'cave',
              },
              syntactic_highlighting: {
                level: 'full',
                preset: 'default',
                overrides: {},
              },
            };
            return baseConfig;
          }

          case 'get_recent_projects':
          case 'list_recent_projects':
            return [
              {
                name: 'Cave System Alpha',
                location: 'Yucatan, Mexico',
                file_path: '/projects/cave-alpha.stalx',
                modified_at: new Date().toISOString(),
                section_count: 5,
                total_length: 1250.5,
                gps_center: [-87.4631, 20.2137],
                gps_bounds: {
                  north: 20.2200,
                  south: 20.2074,
                  east: -87.4568,
                  west: -87.4694,
                },
                collab_enabled: true,
              },
              {
                name: 'Underwater Cave Beta',
                location: 'Florida, USA',
                file_path: '/projects/cave-beta.stalx',
                modified_at: new Date(Date.now() - 86400000).toISOString(),
                section_count: 3,
                total_length: 820.0,
                gps_center: [-82.4584, 29.6516],
                gps_bounds: {
                  north: 29.6550,
                  south: 29.6482,
                  east: -82.4521,
                  west: -82.4647,
                },
                collab_enabled: false,
              },
              {
                name: 'Deep Cave Gamma',
                location: 'Bahamas',
                file_path: '/projects/cave-gamma.stalx',
                modified_at: new Date(Date.now() - 172800000).toISOString(),
                section_count: 8,
                total_length: 2100.3,
                gps_center: [-77.3963, 25.0343],
                gps_bounds: null,
                collab_enabled: false,
              },
              {
                name: 'Local Survey (No GPS)',
                location: 'Unknown',
                file_path: '/projects/local-survey.stalx',
                modified_at: new Date(Date.now() - 259200000).toISOString(),
                section_count: 2,
                total_length: 350.0,
                gps_center: null,
                gps_bounds: null,
                collab_enabled: false,
              },
            ].map((p) =>
              recentNameOverrides[p.file_path]
                ? { ...p, name: recentNameOverrides[p.file_path] }
                : p
            );

          case 'get_warnings':
          case 'get_project_warnings':
            return [];

          case 'check_project_integrity':
            return { messages: mockIntegrityIssues, save_blocked: mockIntegritySaveBlocked };

          case 'repair_project_integrity': {
            const total = mockIntegrityIssues.length;
            const remaining = Math.min(mockIntegrityRemaining, total);
            const fixed = total - remaining;
            // Keep the trailing `remaining` issues as detect-only residue.
            mockIntegrityIssues = mockIntegrityIssues.slice(total - remaining);
            return { fixed, remaining };
          }

          case 'remove_from_recent_projects':
            // Mock remove from recent - just return success
            console.log('[Mock IPC] remove_from_recent_projects called with:', args);
            return { success: true };

          case 'delete_project':
            // Mock destructive delete - acknowledge success. We don't mutate the
            // hardcoded recents list here (would leak across tests in a worker);
            // the store + Rust tests cover the recents-removal side effect.
            console.log('[Mock IPC] delete_project called with:', args);
            return { success: true };

          case 'set_project_name_for_path': {
            const p = String(args?.path ?? '');
            const name = String(args?.name ?? '').trim();
            if (!name) return { success: false, error: 'Project name cannot be empty' };
            recentNameOverrides[p] = name;
            return { success: true };
          }

          // Display settings (per-project) - uses in-memory storage for persistence testing
          case 'load_display_settings':
            // Return current display settings from in-memory storage
            return { ...mockDisplaySettings };

          case 'save_display_setting': {
            // Persist setting to in-memory storage
            const key = args?.key as string;
            const value = args?.value as string;
            if (key && value !== undefined) {
              mockDisplaySettings[key] = value;
              console.log(`[Mock IPC] save_display_setting: ${key}=${value}`);
            }
            return undefined;
          }

          case 'get_display_setting': {
            // Return specific setting from in-memory storage
            const settingKey = args?.key as string;
            return settingKey ? mockDisplaySettings[settingKey] ?? null : null;
          }

          // Window plugin commands
          case 'plugin:window|set_title':
          case 'plugin:window|current':
            return { label: 'main' };

          case 'get_stations':
            return [];

          // Plugin commands
          case 'plugin:dialog|open':
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

          // Opener plugin commands
          case 'plugin:opener|reveal_item_in_dir':
            console.log('[Mock IPC] reveal_item_in_dir called with:', args);
            return undefined;

          case 'plugin:opener|open_path':
            console.log('[Mock IPC] open_path called with:', args);
            return undefined;

          // Export commands
          // Depth color presets for export
          case 'get_depth_preset_colors': {
            const preset = args?.preset as string;
            console.log('[Mock IPC] get_depth_preset_colors called with preset:', preset);
            // Returns { stops: ColorStop[] } where ColorStop = { position: number; color: string }
            const presetStops: Record<string, { stops: Array<{ position: number; color: string }> }> = {
              thermal: { stops: [{ position: 0.0, color: '#00bfff' }, { position: 1.0, color: '#ff4444' }] },
              ocean: { stops: [{ position: 0.0, color: '#00ffff' }, { position: 1.0, color: '#0000aa' }] },
              terrain: { stops: [{ position: 0.0, color: '#00ff00' }, { position: 1.0, color: '#8b4513' }] },
              grayscale: { stops: [{ position: 0.0, color: '#ffffff' }, { position: 1.0, color: '#000000' }] },
              accessible: { stops: [{ position: 0.0, color: '#7c3aed' }, { position: 1.0, color: '#fde047' }] },
            };
            return presetStops[preset] ?? presetStops.thermal;
          }

          case 'export_csv':
            console.log('[Mock IPC] export_csv called with:', args);
            return { success: true, path: args?.path };

          case 'export_json':
            console.log('[Mock IPC] export_json called with:', args);
            return { success: true, path: args?.path };

          case 'preview_svg_export': {
            // Stick-map preview lives in the same backend command pipeline; the
            // mock returns a tiny but valid SVG so the preview component can
            // render without hitting Rust during e2e tests.
            const opts = args?.options as Record<string, unknown> | undefined;
            const threshold = (opts?.branching_threshold as number | undefined) ?? 0;
            // Encode the threshold in a data attribute so tests can verify
            // the preview re-fetches when the slider changes.
            return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" data-threshold="${threshold}"><rect width="100" height="100" fill="#ffffff"/><line x1="10" y1="50" x2="90" y2="50" stroke="#000000" stroke-width="1"/></svg>`;
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
            return new Promise(resolve => setTimeout(() => resolve({ success: true, path: args?.path }), 500));
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
            return { success: true };
          }

          case 'delete_shot':
            console.log('[Mock IPC] delete_shot called with:', args);
            return { success: true };

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
                  closure_id: 1n,
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
            };
          }

          case 'delete_shot_and_split':
            console.log('[Mock IPC] delete_shot_and_split called with:', args);
            return { success: true };

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
            };
          }

          case 'delete_shot_range_split':
            console.log('[Mock IPC] delete_shot_range_split called with:', args);
            return { success: true };

          case 'delete_shot_range_shift':
            console.log('[Mock IPC] delete_shot_range_shift called with:', args);
            return { success: true };

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
            return { success: true };
          }

          case 'delete_section': {
            console.log('[Mock IPC] delete_section called with:', args);
            const sectionId = (args?.sectionId ?? args?.section_id) as number;
            if (currentProject && sectionId !== undefined) {
              currentProject.sections = (currentProject.sections as Array<{ id: number }>).filter(
                (s) => s.id !== sectionId,
              );
            }
            return { success: true };
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
              return { success: false, error: `Section ${sectionId} not found` };
            }
            const shotData = (args?.shot ?? {}) as Record<string, unknown>;
            const afterShotId = (args?.afterShotId ?? args?.after_shot_id ?? null) as number | null;
            const beforeShotId = (args?.beforeShotId ?? args?.before_shot_id ?? null) as number | null;
            const nextId = section.shots.reduce((max, s) => Math.max(max, s.id), 0) + 1;
            const newShot = {
              id: nextId,
              azimuth_in: (shotData.azimuth_in as number) ?? 0,
              azimuth_out: (shotData.azimuth_out as number) ?? 0,
              length: (shotData.length as number) ?? 0,
              depth_in: (shotData.depth_in as number) ?? 0,
              depth_out: (shotData.depth_out as number) ?? 0,
              pitch_in: (shotData.pitch_in as number | null | undefined) ?? null,
              pitch_out: (shotData.pitch_out as number | null | undefined) ?? null,
              left: (shotData.left as number | null | undefined) ?? null,
              right: (shotData.right as number | null | undefined) ?? null,
              up: (shotData.up as number | null | undefined) ?? null,
              down: (shotData.down as number | null | undefined) ?? null,
              comment: (shotData.comment as string | null | undefined) ?? null,
              is_reference: (shotData.is_reference as boolean | undefined) ?? false,
              marker_index: (shotData.marker_index as number | null | undefined) ?? null,
              temperature: (shotData.temperature as number | null | undefined) ?? null,
            };
            let insertAt = section.shots.length;
            if (afterShotId !== null) {
              const i = section.shots.findIndex((s) => s.id === afterShotId);
              if (i >= 0) insertAt = i + 1;
            } else if (beforeShotId !== null) {
              const i = section.shots.findIndex((s) => s.id === beforeShotId);
              if (i >= 0) insertAt = i;
            }
            section.shots.splice(insertAt, 0, newShot);
            return { success: true, shot_id: nextId };
          }

          case 'merge_projects':
            console.log('[Mock IPC] merge_projects called with:', args);
            return { success: true };

          case 'set_shot_reference': {
            console.log('[Mock IPC] set_shot_reference called with:', args);
            const sectionId = (args?.sectionId ?? args?.section_id) as number;
            const shotId = (args?.shotId ?? args?.shot_id) as number;
            const isReference = (args?.isReference ?? args?.is_reference) as boolean;
            if (currentProject && sectionId && shotId !== undefined) {
              const section = (
                currentProject.sections as Array<{ id: number; shots: Array<{ id: number }> }>
              ).find((s) => s.id === sectionId);
              if (section) {
                const shot = section.shots.find((s) => s.id === shotId);
                if (shot) {
                  (shot as { is_reference?: boolean }).is_reference = isReference;
                }
              }
            }
            return { success: true };
          }

          // Raw sqlite browsing (data table fullscreen)
          case 'get_raw_table_names': {
            console.log('[Mock IPC] get_raw_table_names called');
            if (!currentProject) {
              throw new Error('No project database; save the project to browse raw data');
            }
            // Alphabetical, mirroring list_raw_table_names' ORDER BY name.
            return ['project', 'sections', 'shots', 'undo_stack'];
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
                  'up_distance', 'down_distance', 'comment', 'is_reference', 'marker_index', 'temperature', 'uuid',
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
                    shot.is_reference ? '1' : '0',
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
            };
          }

          // Cache commands
          case 'get_cache_stats':
            console.log('[Mock IPC] get_cache_stats called');
            return mockCacheStats;

          case 'clear_tile_cache': {
            // Normalize provider: could be string, null, or undefined from frontend
            const provider = typeof args?.provider === 'string' ? args.provider : undefined;
            console.log('[Mock IPC] clear_tile_cache called, provider:', provider);
            if (provider) {
              // Clear specific provider
              delete mockCacheStats.providers[provider];
              // Recalculate totals
              let totalTiles = 0n;
              let totalBytes = 0n;
              for (const p of Object.values(mockCacheStats.providers)) {
                totalTiles += p.tiles;
                totalBytes += p.bytes;
              }
              mockCacheStats.total_tiles = totalTiles;
              mockCacheStats.total_bytes = totalBytes;
            } else {
              // Clear all
              mockCacheStats = { total_tiles: 0n, total_bytes: 0n, providers: {} };
            }
            return null; // Tauri serializes () as null
          }

          case 'get_network_status':
            console.log('[Mock IPC] get_network_status called');
            return mockNetworkStatus;

          case 'get_tile_providers':
            // Return TileProviderInfo[] matching Rust struct shape
            console.log('[Mock IPC] get_tile_providers called');
            return [
              {
                name: 'esri',
                display_label: 'ESRI World Imagery',
                url_template: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
                attribution: '© Esri, Maxar, Earthstar Geographics',
                tile_size: 256,
                min_zoom: 1,
                max_zoom: 22,
                content_type_hint: 'image/jpeg',
                api_key_env: null,
                auth_header: null,
                available: true,
              },
            ];

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
            const mockGeometry = {
              origin: [-82.46, 24.93] as [number, number],
              shots: [
                { from: [-82.46, 24.93] as [number, number], to: [-82.4599, 24.9301] as [number, number], is_reference: false, section_id: 1 },
                { from: [-82.4599, 24.9301] as [number, number], to: [-82.4598, 24.9302] as [number, number], is_reference: false, section_id: 1 },
              ],
            };

            if (delay && delay > 0) {
              return new Promise((resolve) => setTimeout(() => resolve(mockGeometry), delay));
            }

            return mockGeometry;
          }

          // Collaboration mode
          case 'set_collab_enabled':
            console.log('[Mock IPC] set_collab_enabled called with:', args);
            return { success: true };
          case 'set_collab_enabled_for_path':
            console.log('[Mock IPC] set_collab_enabled_for_path called with:', args);
            return { success: true };
          case 'get_collab_state':
            return null;
          case 'detect_collab_changes':
            return null;
          case 'collab_sibling_when_disabled':
            return null;
          case 'apply_collab_changes':
            console.log('[Mock IPC] apply_collab_changes called with:', args);
            return { success: true };

          // Silent no-ops: commands that should succeed without side-effects
          case 'push_frontend_log':
            return null;

          // SpeleoDB (#203/#204/#205): deterministic logged-out / local defaults so
          // the settings tab + browser render without a live server. No e2e spec
          // drives the hand-off yet; these keep the mounts from erroring on null.
          case 'speleodb_session':
            return { logged_in: false, user_email: null, endpoint: null, keychain_backed: false };
          case 'speleodb_link_status':
            // Full SpeleoLinkStatus shape (remote_state / access_denied / server_error
            // included) so a spec that flips is_remote:true still matches the DTO.
            return {
              is_remote: false,
              edit_enabled: true,
              has_unpushed_edits: false,
              permission: null,
              lock_holder: null,
              remote_state: 'unknown',
              access_denied: false,
              server_error: null,
              exclude_geojson: false,
            };
          case 'speleodb_list_projects':
            return [];
          case 'speleodb_take_remote':
            // Returns the reloaded .stalx path (#198); no e2e spec drives it yet.
            return '/mock/project.stalx';
          case 'speleodb_logout':
          case 'speleodb_unlink':
          case 'speleodb_release_all_locks':
          case 'speleodb_release_lock':
          case 'speleodb_set_exclude_geojson':
            return null;
          case 'speleodb_get_project_metadata':
          case 'speleodb_patch_project':
            // Deterministic project metadata for the #206 settings tab. patch echoes
            // the same shape (a real server would return post-edit truth).
            return {
              name: 'Mock Cave',
              description: '',
              country: 'US',
              visibility: 'PRIVATE',
              latitude: null,
              longitude: null,
              exclude_geojson: false,
            };
          case 'speleodb_publish':
            // #207 publish result: the reloaded (now-remote) local .stalx path.
            return {
              project_id: 'mock-project-id',
              endpoint: 'https://speleodb.example',
              local_path: '/mock/project.stalx',
            };
          case 'speleodb_login':
            return {
              user_email: 'test@example.com',
              endpoint: 'https://speleodb.example',
              keychain_backed: true,
            };

          default:
            console.warn(`[Mock IPC] Unhandled command: ${cmd}`);
            return null;
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
  });
}

/**
 * Set up mocks with a custom project already loaded.
 */
export async function setupTauriMocksWithProject(
  page: Page,
  project: Partial<MockProject>
): Promise<void> {
  await page.addInitScript(
    (projectData) => {
      const currentProject = {
        id: projectData.id ?? 'mock-project-001',
        name: projectData.name ?? 'Test Project',
        sections: projectData.sections ?? [],
        station_merges: projectData.station_merges ?? [],
        zero_datums: projectData.zero_datums ?? [],
        section_offsets: projectData.section_offsets ?? {},
      };

      const mockHandler = (cmd: string, args?: Record<string, unknown>): unknown => {
        if (cmd !== 'push_frontend_log') {
          console.log(`[Mock IPC] Command: ${cmd}`, args);
        }

        switch (cmd) {
          case 'get_project':
          case 'load_project':
            return currentProject;
          case 'save_project':
            return { success: true };
          case 'push_frontend_log':
            return null;
          default:
            return null;
        }
      };

      (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
        invoke: async (cmd: string, args?: Record<string, unknown>) => {
          return mockHandler(cmd, args);
        },
        transformCallback: (callback: () => void) => {
          const id = Math.random().toString(36).substring(7);
          (window as unknown as Record<string, unknown>)[`_${id}`] = callback;
          return id;
        },
        // sep()/delimiter() in @tauri-apps/api/path read these synchronously.
        plugins: {
          path: { sep: '/', delimiter: ':' },
        },
      };

      console.log('[Mock IPC] Tauri mocks with project installed');
    },
    project
  );
}

export { createMockProject, createMockSection };
export type { MockProject, MockSection, MockShot };
