import { Page } from '@playwright/test';

/**
 * Mock data types matching the CaveChef Rust backend models.
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
        tiles: number;
        bytes: number;
      }
      interface MockCacheStats {
        total_tiles: number;
        total_bytes: number;
        providers: Record<string, MockProviderStats>;
      }
      const defaultCacheStats: MockCacheStats = {
        total_tiles: 150,
        total_bytes: 25600000, // ~25MB
        providers: {
          esri: { tiles: 150, bytes: 25600000 },
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

      // Track last export_image call for test assertions
      let lastExportImageArgs: Record<string, unknown> | null = null;

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

      return function mockCommand(
        cmd: string,
        args?: Record<string, unknown>
      ): unknown {
        console.log(`[Mock IPC] Command: ${cmd}`, args);

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

          case 'create_project_full': {
            // Consolidated create_project_full command for loading progress feature
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

            // Return CreateProjectFullResult format
            return {
              loadingId: Date.now(),
              project: currentProject,
              displaySettings: {
                showStations: true,
                showSectionNames: true,
                showStationLabels: false,
                showShotData: false,
                showVirtualShots: true,
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
                  { id: 1, azimuth_in: 45, azimuth_out: 225, length: 10, depth_in: 0, depth_out: -2, is_virtual: false },
                  { id: 2, azimuth_in: 90, azimuth_out: 270, length: 15, depth_in: -2, depth_out: -5, is_virtual: false },
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
            }> = [];

            // Collect all section IDs for merged station setup
            const sectionIds = (currentProject.sections as Array<{ id: number }>).map(s => s.id);

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
                // Set up merged_with for testing: last station of first section merges with first station of second section
                // This enables E2E tests for merged station links without direct store manipulation
                let mergedWith: Array<{ section_id: number; station_index: number }> = [];
                const sectionIndex = sectionIds.indexOf(section.id);
                const isLastStation = i === depths.length - 1;
                const isFirstStation = i === 0;

                // Last station of first section -> merge with first station of second section (if exists)
                if (sectionIndex === 0 && isLastStation && sectionIds.length > 1) {
                  mergedWith = [{ section_id: sectionIds[1]!, station_index: 0 }];
                }
                // First station of second section -> merge with last station of first section
                if (sectionIndex === 1 && isFirstStation && sectionIds.length > 1) {
                  // Find last station index of first section
                  const firstSection = currentProject.sections[0] as { shots: unknown[] } | undefined;
                  const firstSectionLastStationIndex = firstSection ? (firstSection.shots?.length ?? 0) : 0;
                  mergedWith = [{ section_id: sectionIds[0]!, station_index: firstSectionLastStationIndex }];
                }

                // Derive is_zero_datum and gps_coordinates from project zero_datums
                const loadDatum = loadDatums.find(
                  (d) => d.station_ref.section_id === section.id && d.station_ref.station_index === i
                );

                mockStations.push({
                  station_ref: { section_id: section.id, station_index: i },
                  coordinates: { x: i * 10, y: 0, z: depths[i] ?? 0 },
                  is_zero_datum: !!loadDatum,
                  gps_coordinates: loadDatum ? loadDatum.gps : null,
                  merged_with: mergedWith,
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
                showVirtualShots: true,
                showZeroDatum: true,
                showGrid: false,
                showScaleBar: true,
                showSatellite: false,
                showDepthGradient: false,
                gridSpacing: 10,
              },
            };
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
            return { success: true, path: projectPath };
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

          case 'get_project':
          case 'get_project_state': {
            // Generate mock stations from sections with merged_with data
            const mockStations: Array<{
              station_ref: { section_id: number; station_index: number };
              coordinates: { x: number; y: number; z: number };
              is_zero_datum: boolean;
              gps_coordinates: { latitude: number; longitude: number; depth_reference: number } | null;
              merged_with: Array<{ section_id: number; station_index: number }>;
            }> = [];

            // Collect all section IDs for merged station setup
            const sectionIdList = (currentProject?.sections as Array<{ id: number }> ?? []).map(s => s.id);

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
                  // Set up merged_with: last station of first section merges with first station of second section
                  let mergedWith: Array<{ section_id: number; station_index: number }> = [];
                  const isLastStation = i === shotCount;
                  const isFirstStation = i === 0;

                  // Last station of first section -> merge with first station of second section (if exists)
                  if (sectionIndex === 0 && isLastStation && sectionIdList.length > 1) {
                    mergedWith = [{ section_id: sectionIdList[1]!, station_index: 0 }];
                  }
                  // First station of second section -> merge with last station of first section
                  if (sectionIndex === 1 && isFirstStation && sectionIdList.length > 1) {
                    const firstSection = currentProject.sections[0] as { shots?: unknown[] } | undefined;
                    const firstSectionLastStationIndex = firstSection?.shots?.length ?? 0;
                    mergedWith = [{ section_id: sectionIdList[0]!, station_index: firstSectionLastStationIndex }];
                  }

                  // Derive is_zero_datum and gps_coordinates from project zero_datums
                  const matchingDatum = zeroDatums.find(
                    (d) => d.station_ref.section_id === section.id && d.station_ref.station_index === i
                  );

                  mockStations.push({
                    station_ref: {
                      section_id: section.id,
                      station_index: i,
                    },
                    coordinates: { x: i * 10, y: 0, z: 0 },
                    is_zero_datum: !!matchingDatum,
                    gps_coordinates: matchingDatum ? matchingDatum.gps : null,
                    merged_with: mergedWith,
                  });
                }
              }
            }

            const depthValues = mockStations.map((station) => station.coordinates.z);
            const minDepth = depthValues.length > 0 ? Math.min(...depthValues) : 0;
            const maxDepth = depthValues.length > 0 ? Math.max(...depthValues) : 0;
            const shotCount =
              currentProject?.sections.reduce(
                (count, section) => count + ((section as { shots?: Array<{ length?: number }> }).shots?.length ?? 0),
                0
              ) ?? 0;
            const totalLength =
              currentProject?.sections.reduce((total, section) => {
                const shots = (section as { shots?: Array<{ length?: number }> }).shots ?? [];
                return total + shots.reduce((sum, shot) => sum + (shot.length ?? 0), 0);
              }, 0) ?? 0;

            return {
              project: currentProject,
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
            };
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
              is_virtual: (shot.is_virtual as boolean | undefined) ?? false,
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
            return { success: true, section };
          }

          // File hash tracking for duplicate detection
          case 'calculate_file_hash':
            // Return a mock SHA256 hash based on path for consistency
            return `mock_hash_${(args?.path as string)?.split('/').pop() ?? 'unknown'}`;

          case 'check_duplicate_import':
            // By default, no duplicates in mock
            return false;

          case 'track_imported_file':
            console.log('[Mock IPC] track_imported_file called with:', args);
            return { success: true };

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
                      heading_out: 225, // ~180° apart (valid backsight)
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
                      heading_out: 270, // ~180° apart (valid backsight)
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
                      heading_out: 315, // ~180° apart (valid backsight)
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
                      heading_out: 90, // ~180° apart (valid backsight)
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
                      heading_out: 100, // ~180° apart (valid backsight)
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
                      heading_out: 0, // ~180° apart (valid backsight)
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
                      heading_out: 10, // ~180° apart (valid backsight)
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
                      heading_out: 20, // ~180° apart (valid backsight)
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
                      heading_out: 270, // ~180° apart (valid backsight)
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
                      heading_out: 280, // ~180° apart (valid backsight)
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

          case 'merge_stations':
            // Mock merge stations - just return success
            console.log('[Mock IPC] merge_stations called with:', args);
            return { success: true };

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

          case 'create_loop_closure':
            // Mock create loop closure - return success
            console.log('[Mock IPC] create_loop_closure called with:', args);
            return { success: true };

          case 'unmerge_stations':
            // Mock unmerge stations - return success
            console.log('[Mock IPC] unmerge_stations called with:', args);
            return { success: true };

          case 'move_section':
            // Mock move section - just return success
            console.log('[Mock IPC] move_section called with:', args);
            return { success: true };

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

          case 'undo':
          case 'redo':
            return { success: true };

          case 'can_undo':
            return false;

          case 'can_redo':
            return false;

          case 'get_undo_state':
            return { can_undo: false, can_redo: false };

          case 'get_config':
            // Return saved config if available (for testing persistence)
            if (savedConfig) {
              return savedConfig;
            }
            return {
              general: {
                auto_save: true,
                auto_save_interval_seconds: 30,
                recent_projects_max: 20,
                undo_history_limit: 100,
                undo_persist_limit: 20,
              },
              units: {
                length: 'meters',
                depth: 'meters',
                angle: 'degrees',
                decimal_precision: 1,
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
                },
                shot: {
                  width: 2.0,
                  hit_area: 8.0,
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
                azimuth_diff_threshold: 10.0,
                pitch_diff_threshold: 5.0,
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
                // Tools
                select: ['S'],
                pan: ['P'],
                zoom: ['Z'],
                draw: ['D'],
                delete_tool: ['X'],
                merge: ['M'],
                measure: ['R'],
                move_section: ['V'],
                move_station: ['T'],
                // Edit
                undo: ['Ctrl+Z'],
                redo: ['Ctrl+Y', 'Ctrl+Shift+Z'],
                save: ['Ctrl+S'],
                // View
                toggle_depth_gradient: ['G'],
                toggle_grid: ['Shift+G'],
                toggle_satellite: ['B'],
                toggle_station_labels: ['L'],
                toggle_shot_labels: ['Shift+L'],
                toggle_section_labels: ['Ctrl+L'],
                fit_to_bounds: ['F'],
                zoom_in: ['Equal', 'Plus'],
                zoom_out: ['Minus'],
                // Panels
                toggle_sections_panel: ['Ctrl+1'],
                toggle_detail_panel: ['Ctrl+2'],
                toggle_data_table: ['Ctrl+3'],
              },
              panels: {
                sections_panel_width: 250,
                detail_panel_width: 300,
                data_table_height: 200,
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
            };

          case 'update_config':
            // Mock update_config - store config and return success
            console.log('[Mock IPC] update_config called with:', args);
            savedConfig = args?.config as Record<string, unknown> | undefined ?? null;
            return { success: true };

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
                undo_history_limit: 100,
                undo_persist_limit: 20,
              },
              units: {
                length: 'meters',
                depth: 'meters',
                angle: 'degrees',
                decimal_precision: 1,
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
                },
                shot: {
                  width: 2.0,
                  hit_area: mockConfigOverrides.map?.shot?.hit_area ?? 8.0,
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
                azimuth_diff_threshold: 10.0,
                pitch_diff_threshold: 5.0,
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
                // Tools
                select: ['S'],
                pan: ['P'],
                zoom: ['Z'],
                draw: ['D'],
                delete_tool: ['X'],
                merge: ['M'],
                measure: ['R'],
                move_section: ['V'],
                move_station: ['T'],
                // Edit
                undo: ['Ctrl+Z'],
                redo: ['Ctrl+Y', 'Ctrl+Shift+Z'],
                save: ['Ctrl+S'],
                // View
                toggle_depth_gradient: ['G'],
                toggle_grid: ['Shift+G'],
                toggle_satellite: ['B'],
                toggle_station_labels: ['L'],
                toggle_shot_labels: ['Shift+L'],
                toggle_section_labels: ['Ctrl+L'],
                fit_to_bounds: ['F'],
                zoom_in: ['Equal', 'Plus'],
                zoom_out: ['Minus'],
                // Panels
                toggle_sections_panel: ['Ctrl+1'],
                toggle_detail_panel: ['Ctrl+2'],
                toggle_data_table: ['Ctrl+3'],
              },
              panels: {
                sections_panel_width: 250,
                detail_panel_width: 300,
                data_table_height: 200,
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
            };
            return baseConfig;
          }

          case 'get_recent_projects':
          case 'list_recent_projects':
            return [
              {
                name: 'Cave System Alpha',
                location: 'Yucatan, Mexico',
                file_path: '/projects/cave-alpha.cvproj',
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
              },
              {
                name: 'Underwater Cave Beta',
                location: 'Florida, USA',
                file_path: '/projects/cave-beta.cvproj',
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
              },
              {
                name: 'Deep Cave Gamma',
                location: 'Bahamas',
                file_path: '/projects/cave-gamma.cvproj',
                modified_at: new Date(Date.now() - 172800000).toISOString(),
                section_count: 8,
                total_length: 2100.3,
                gps_center: [-77.3963, 25.0343],
                gps_bounds: null,
              },
              {
                name: 'Local Survey (No GPS)',
                location: 'Unknown',
                file_path: '/projects/local-survey.cvproj',
                modified_at: new Date(Date.now() - 259200000).toISOString(),
                section_count: 2,
                total_length: 350.0,
                gps_center: null,
                gps_bounds: null,
              },
            ];

          case 'get_warnings':
          case 'get_project_warnings':
            return [];

          case 'remove_from_recent_projects':
            // Mock remove from recent - just return success
            console.log('[Mock IPC] remove_from_recent_projects called with:', args);
            return { success: true };

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
            return '/mock/saved-project.cvproj';

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

          case 'export_image': {
            console.log('[Mock IPC] export_image called with:', args);
            // Store args for test assertions via __E2E_MOCKS__.getLastExportImageArgs()
            const exportOptions = args?.options as Record<string, unknown> | undefined;

            // Validate required new options are present (per spec requirements)
            if (exportOptions) {
              if (exportOptions.color_mode === undefined) {
                throw new Error('[Mock IPC] export_image: missing required option "color_mode"');
              }
              if (exportOptions.depth_preset === undefined) {
                throw new Error('[Mock IPC] export_image: missing required option "depth_preset"');
              }
              if (exportOptions.include_legend === undefined) {
                throw new Error('[Mock IPC] export_image: missing required option "include_legend"');
              }
              // Validate color_mode is a valid value
              const validColorModes = ['section', 'depth'];
              if (!validColorModes.includes(exportOptions.color_mode as string)) {
                throw new Error(`[Mock IPC] export_image: invalid color_mode "${exportOptions.color_mode}", must be one of: ${validColorModes.join(', ')}`);
              }
              // Validate depth_preset is a valid value
              const validPresets = ['thermal', 'ocean', 'terrain', 'grayscale', 'accessible'];
              if (!validPresets.includes(exportOptions.depth_preset as string)) {
                throw new Error(`[Mock IPC] export_image: invalid depth_preset "${exportOptions.depth_preset}", must be one of: ${validPresets.join(', ')}`);
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

          case 'delete_section':
            console.log('[Mock IPC] delete_section called with:', args);
            return { success: true };

          case 'create_shot':
            console.log('[Mock IPC] create_shot called with:', args);
            return { success: true, shot_id: Date.now() };

          case 'set_shot_virtual': {
            console.log('[Mock IPC] set_shot_virtual called with:', args);
            const sectionId = args?.section_id as number;
            const shotId = args?.shot_id as number;
            const isVirtual = args?.is_virtual as boolean;
            if (currentProject && sectionId && shotId !== undefined) {
              const section = currentProject.sections.find(s => s.id === sectionId);
              if (section) {
                const shot = section.shots.find((s: { id: number }) => s.id === shotId);
                if (shot) {
                  (shot as { is_virtual?: boolean }).is_virtual = isVirtual;
                }
              }
            }
            return { success: true };
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
              let totalTiles = 0;
              let totalBytes = 0;
              for (const p of Object.values(mockCacheStats.providers)) {
                totalTiles += p.tiles;
                totalBytes += p.bytes;
              }
              mockCacheStats.total_tiles = totalTiles;
              mockCacheStats.total_bytes = totalBytes;
            } else {
              // Clear all
              mockCacheStats = { total_tiles: 0, total_bytes: 0, providers: {} };
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
                { from: [-82.46, 24.93] as [number, number], to: [-82.4599, 24.9301] as [number, number], is_virtual: false, section_id: 1 },
                { from: [-82.4599, 24.9301] as [number, number], to: [-82.4598, 24.9302] as [number, number], is_virtual: false, section_id: 1 },
              ],
            };

            if (delay && delay > 0) {
              return new Promise((resolve) => setTimeout(() => resolve(mockGeometry), delay));
            }

            return mockGeometry;
          }

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
        return '/mock/saved-project.cvproj';
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
        console.log(`[Mock IPC] Command: ${cmd}`, args);

        switch (cmd) {
          case 'get_project':
          case 'load_project':
            return currentProject;
          case 'save_project':
            return { success: true };
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
      };

      console.log('[Mock IPC] Tauri mocks with project installed');
    },
    project
  );
}

export { createMockProject, createMockSection };
export type { MockProject, MockSection, MockShot };
