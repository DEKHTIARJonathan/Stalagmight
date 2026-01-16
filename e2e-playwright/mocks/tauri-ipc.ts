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
 * Mock Tauri IPC command handler.
 * Maps command names to mock responses.
 */
function createMockCommandHandler() {
  // State to track the current project
  let currentProject: MockProject | null = null;
  let projectPath: string | null = null;
  let sectionCounter = 0;

  return function mockCommand(cmd: string, args?: Record<string, unknown>): unknown {
    console.log(`[Mock IPC] Command: ${cmd}`, args);

    switch (cmd) {
      // Project commands
      case 'create_project': {
        const name = (args?.name as string) ?? 'Untitled Project';
        currentProject = createMockProject({ name });
        return currentProject;
      }

      case 'load_project': {
        projectPath = (args?.path as string) ?? null;
        if (!currentProject) {
          currentProject = createMockProject();
        }
        return currentProject;
      }

      case 'save_project': {
        projectPath = (args?.path as string) ?? projectPath;
        return { success: true, path: projectPath };
      }

      case 'close_project': {
        currentProject = null;
        projectPath = null;
        return { success: true };
      }

      case 'get_project': {
        return currentProject;
      }

      // Section commands
      case 'create_section': {
        if (!currentProject) {
          throw new Error('No project open');
        }
        sectionCounter++;
        const section = createMockSection({
          id: `section-${sectionCounter}`,
          name: (args?.name as string) ?? `Section ${sectionCounter}`,
          shots: (args?.shots as MockShot[]) ?? [],
        });
        currentProject.sections.push(section);
        return section;
      }

      case 'update_section': {
        const sectionId = args?.section_id as string;
        const section = currentProject?.sections.find((s) => s.id === sectionId);
        if (section) {
          Object.assign(section, args);
        }
        return section;
      }

      case 'delete_section': {
        const deleteId = args?.section_id as string;
        if (currentProject) {
          currentProject.sections = currentProject.sections.filter(
            (s) => s.id !== deleteId
          );
        }
        return { success: true };
      }

      // DMP Import
      case 'import_dmp':
      case 'parse_dmp': {
        return createMockSection({
          id: `imported-${Date.now()}`,
          name: (args?.name as string) ?? 'Imported Section',
          shots: [
            { id: 1, azimuth: 45, length: 10, depth: -2 },
            { id: 2, azimuth: 90, length: 15, depth: -5 },
            { id: 3, azimuth: 135, length: 8, depth: -3 },
          ],
        });
      }

      // Undo/Redo
      case 'undo': {
        return { success: true, can_undo: true, can_redo: true };
      }

      case 'redo': {
        return { success: true, can_undo: true, can_redo: true };
      }

      case 'can_undo': {
        return true;
      }

      case 'can_redo': {
        return true;
      }

      // Config
      case 'get_config': {
        return {
          auto_save: true,
          recent_projects: [],
          recent_projects_max: 10,
        };
      }

      case 'update_config': {
        return { success: true };
      }

      // Recent projects
      case 'get_recent_projects': {
        return [];
      }

      case 'add_recent_project': {
        return { success: true };
      }

      // File dialogs (these return null to indicate cancelled)
      case 'plugin:dialog|open':
      case 'plugin:dialog|save': {
        // Return null to simulate cancelled dialog
        // In real tests, you might want to return a mock path
        return null;
      }

      // File system operations
      case 'plugin:fs|read':
      case 'plugin:fs|readFile': {
        return new Uint8Array([]);
      }

      case 'plugin:fs|write':
      case 'plugin:fs|writeFile': {
        return { success: true };
      }

      case 'plugin:fs|exists': {
        return false;
      }

      default:
        console.warn(`[Mock IPC] Unhandled command: ${cmd}`);
        return null;
    }
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
            return {
              project: currentProject,
              stations: [],
              stats: {
                section_count: currentProject?.sections.length ?? 0,
                shot_count: 0,
                total_length: 0,
                min_depth: 0,
                max_depth: 0,
                station_count: 0,
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
              sections: [{
                name: (args?.name as string) ?? 'Imported Section',
                surveyor: 'Imported',
                date: new Date().toISOString().split('T')[0],
                shots: [
                  { azimuth: 45, length: 10, depth: -2 },
                  { azimuth: 90, length: 15, depth: -5 },
                  { azimuth: 135, length: 8, depth: -3 },
                ],
              }],
            };
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
            return [];

          case 'get_warnings':
          case 'get_project_warnings':
            return [];

          // Window plugin commands
          case 'plugin:window|set_title':
          case 'plugin:window|current':
            return { label: 'main' };

          case 'get_stations':
            return [];

          // Plugin commands
          case 'plugin:dialog|open':
          case 'plugin:dialog|save':
            return null;

          case 'plugin:fs|read':
          case 'plugin:fs|readFile':
            return new Uint8Array([]);

          case 'plugin:fs|write':
          case 'plugin:fs|writeFile':
            return null;

          case 'plugin:fs|exists':
            return false;

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
