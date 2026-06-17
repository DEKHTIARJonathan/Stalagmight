import { resetAppState, waitForAppReady, waitForUiIdle } from '../helpers/app';

interface SaveNowRunResult {
  ok: boolean;
  createResult?: {
    success: boolean;
    error?: string | null;
  };
  snapshot?: SaveNowSpySnapshot;
  error?: string;
}

interface SaveNowSpySnapshot {
  selectedPath: string;
  counts: {
    createProject: number;
    saveProject: number;
  };
  error: string | null;
  projectFilePath: string | null;
}

describe('Save Immediately Single Write', () => {
  beforeEach(async () => {
    await waitForAppReady();
    await resetAppState();
  });

  it('uses createProject with an explicit save path and does not call saveProject', async () => {
    const runResult = await browser.executeAsync((done: (result: SaveNowRunResult) => void) => {
      const w = window as unknown as {
        __E2E_TEST__?: {
          projectStore?: {
            getState: () => {
              project: { file_path: string | null } | null;
              createProject: (
                name: string,
                projectLocation?: string,
                options?: { savePath?: string; saveDirectory?: string }
              ) => Promise<{ success: boolean; error?: string | null }>;
              saveProject: (path?: string) => Promise<{ success: boolean; error?: string | null }>;
            };
            setState: (partial: Record<string, unknown>) => void;
          };
          uiStore?: {
            getState: () => {
              setView: (view: 'global' | 'single') => void;
            };
          };
        };
      };

      const projectStore = w.__E2E_TEST__?.projectStore;
      const setView = w.__E2E_TEST__?.uiStore?.getState().setView;
      if (!projectStore || !setView) {
        done({ ok: false, error: 'E2E stores not available' });
        return;
      }

      const selectedPath = `/tmp/wdio-save-now-${Date.now()}.stalx`;
      let createProjectCalls = 0;
      let saveProjectCalls = 0;
      const originalCreateProject = projectStore.getState().createProject;
      const originalSaveProject = projectStore.getState().saveProject;

      projectStore.setState({
        createProject: async (...args: Parameters<typeof originalCreateProject>) => {
          createProjectCalls += 1;
          return originalCreateProject(...args);
        },
        saveProject: async (...args: Parameters<typeof originalSaveProject>) => {
          saveProjectCalls += 1;
          return originalSaveProject(...args);
        },
      });

      const snapshotBase: Omit<SaveNowSpySnapshot, 'error' | 'projectFilePath'> = {
        selectedPath,
        counts: {
          createProject: createProjectCalls,
          saveProject: 0,
        },
      };

      void (async () => {
        try {
          const createResult = await projectStore.getState().createProject(
            `WDIO Save Now ${Date.now()}`,
            undefined,
            { savePath: selectedPath }
          );

          if (createResult.success) {
            setView('single');
          }

          const projectFilePath = projectStore.getState().project?.file_path ?? null;
          done({
            ok: true,
            createResult,
            snapshot: {
              ...snapshotBase,
              counts: {
                createProject: createProjectCalls,
                saveProject: saveProjectCalls,
              },
              error: null,
              projectFilePath,
            },
          });
        } catch (error) {
          done({
            ok: false,
            error: String(error),
            snapshot: {
              ...snapshotBase,
              counts: {
                createProject: createProjectCalls,
                saveProject: saveProjectCalls,
              },
              error: String(error),
              projectFilePath: projectStore.getState().project?.file_path ?? null,
            },
          });
        } finally {
          projectStore.setState({
            createProject: originalCreateProject,
            saveProject: originalSaveProject,
          });
        }
      })();
    });

    expect(runResult.ok).toBe(true);
    if (!runResult.ok) {
      throw new Error(runResult.error ?? 'Save-now flow failed');
    }

    expect(runResult.createResult?.success).toBe(true);
    expect(runResult.createResult?.error ?? null).toBeNull();

    await browser.waitUntil(
      async () => await $('[data-testid="single-system-view"]').isExisting(),
      { timeout: 15000, timeoutMsg: 'Single system view did not appear after explicit save-path create' }
    );
    await waitForUiIdle(300);

    const spySnapshot = runResult.snapshot;
    expect(spySnapshot).toBeDefined();
    expect(spySnapshot?.error).toBeNull();
    expect(spySnapshot?.counts.createProject).toBe(1);
    expect(spySnapshot?.counts.saveProject).toBe(0);
    expect(spySnapshot?.projectFilePath).toBe(spySnapshot?.selectedPath);
  });
});
