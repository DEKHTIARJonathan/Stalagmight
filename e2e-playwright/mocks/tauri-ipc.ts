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

      return function mockCommand(
        cmd: string,
        args?: Record<string, unknown>
      ): unknown {
        console.log(`[Mock IPC] Command: ${cmd}`, args);

        switch (cmd) {
          case 'create_project': {
            const name = (args?.name as string) ?? 'Untitled Project';
            const now = new Date().toISOString();
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

          case 'get_project':
          case 'get_project_state': {
            // Generate mock stations from sections
            const mockStations: Array<{
              station_ref: { section_id: number; station_index: number };
              coordinates: { x: number; y: number; z: number };
              is_zero_datum: boolean;
              gps_coordinates: null;
              merged_with: never[];
            }> = [];

            if (currentProject?.sections) {
              for (const section of currentProject.sections as Array<{ id: number; shots: unknown[] }>) {
                // Each section gets (shots.length + 1) stations
                const shotCount = section.shots?.length ?? 0;
                for (let i = 0; i <= shotCount; i++) {
                  mockStations.push({
                    station_ref: {
                      section_id: section.id,
                      station_index: i,
                    },
                    coordinates: { x: i * 10, y: 0, z: 0 },
                    is_zero_datum: i === 0,
                    gps_coordinates: null,
                    merged_with: [],
                  });
                }
              }
            }

            return {
              project: currentProject,
              stations: mockStations,
              stats: {
                section_count: currentProject?.sections.length ?? 0,
                shot_count: mockStations.length > 0 ? mockStations.length - 1 : 0,
                total_length: 0,
                min_depth: 0,
                max_depth: 0,
                station_count: mockStations.length,
                loop_count: 0,
                penetration_distance: 0,
              },
            };
          }

          case 'create_section': {
            sectionCounter++;
            const section = {
              id: sectionCounter,
              name: (args?.name as string) ?? `Section ${sectionCounter}`,
              surveyor: 'Test Surveyor',
              date: new Date().toISOString().split('T')[0],
              color: '#3b82f6',
              shots: args?.shots ?? [],
            };
            currentProject?.sections.push(section);
            return { success: true, section };
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

          case 'move_section':
            // Mock move section - just return success
            console.log('[Mock IPC] move_section called with:', args);
            return { success: true };

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
                station_size: 6,
                line_thickness: 2,
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
                satellite_provider: 'openstreetmap',
                satellite_enabled: false,
                snap_threshold_pixels: 10,
                zoom_default: 15,
                zoom_min: 1,
                zoom_max: 22,
                controls: {
                  pan_speed: 1.0,
                  zoom_speed: 1.0,
                  invert_scroll: false,
                },
              },
              validation: {
                warn_shot_length_min: 0.1,
                warn_shot_length_max: 50.0,
                warn_depth_change_per_shot_max: 10.0,
                warn_azimuth_deviation_max: 30.0,
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
                select: 'S',
                pan: 'P',
                zoom: 'Z',
                draw: 'D',
                delete: 'X',
                merge: 'M',
                measure: 'R',
                move_section: 'V',
                move_station: 'T',
                undo: 'Ctrl+Z',
                redo: 'Ctrl+Y',
                save: 'Ctrl+S',
              },
              snap: {
                enabled_draw: true,
                enabled_merge: true,
                enabled_measure: true,
                threshold_pixels: 10,
              },
              panels: {
                sections_panel_width: 250,
                detail_panel_width: 300,
                data_table_height: 200,
              },
            };

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

          // Display settings (per-project)
          case 'load_display_settings':
            // Return empty settings for mocked tests (uses defaults)
            return {};

          case 'save_display_setting':
            // No-op for mocked tests
            return undefined;

          case 'get_display_setting':
            // Return undefined for mocked tests
            return null;

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
