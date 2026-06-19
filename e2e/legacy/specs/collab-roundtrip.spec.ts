/**
 * WebdriverIO E2E Tests: Collaboration round-trip (fullstack)
 *
 * Runs against the real Tauri backend (real reconcile + real `.stalx`/`.tml` on
 * disk), so it asserts what the mocked Playwright suite cannot: that an external
 * Ariane edit is detected, applied, converges, and is undoable. Layer 3 of
 * docs/collab-stress-testing.md.
 *
 * The native file picker is bypassed via the `__E2E_TEST__` store helpers
 * (`saveProject(path)`, `loadProject(path)`, `exportTml(path)`); the sibling
 * `.tml` is manipulated from Node. Reconcile fires on `loadProject` (not the
 * deprecated `openProject`).
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
  waitForAppReady,
  resetAppState,
  createNewProject,
  importDmpViaStore,
  getProjectStats,
  waitForUiIdle,
  undo,
  redo,
} from '../helpers/app';

const FIXTURES_DIR = path.resolve(process.cwd(), 'e2e', 'fixtures');
const DMP = path.join(FIXTURES_DIR, 'test_v2.dmp');

let tempDir: string;

// --- store accessors (each isolates one typed window cast) -----------------

async function setCollabEnabled(enabled: boolean): Promise<{ success: boolean; error?: string }> {
  return browser.executeAsync(
    (en: boolean, done: (r: { success: boolean; error?: string }) => void) => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            getState: () => {
              setCollabEnabled: (e: boolean) => Promise<{ success: boolean; error?: string }>;
            };
          };
        };
      }).__E2E_TEST__;
      if (!e2e) {
        done({ success: false, error: 'E2E helpers not found' });
        return;
      }
      e2e.projectStore
        .getState()
        .setCollabEnabled(en)
        .then(done)
        .catch((err) => done({ success: false, error: String(err) }));
    },
    enabled
  );
}

async function saveProjectTo(p: string): Promise<{ success: boolean; error?: string }> {
  return browser.executeAsync(
    (savePath: string, done: (r: { success: boolean; error?: string }) => void) => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            getState: () => {
              saveProject: (path?: string) => Promise<{ success: boolean; error?: string }>;
            };
          };
        };
      }).__E2E_TEST__;
      if (!e2e) {
        done({ success: false, error: 'E2E helpers not found' });
        return;
      }
      e2e.projectStore
        .getState()
        .saveProject(savePath)
        .then(done)
        .catch((err) => done({ success: false, error: String(err) }));
    },
    p
  );
}

async function loadProjectFrom(p: string): Promise<{ success: boolean }> {
  return browser.executeAsync(
    (openPath: string, done: (r: { success: boolean }) => void) => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: { getState: () => { loadProject: (path: string) => Promise<{ success: boolean }> } };
        };
      }).__E2E_TEST__;
      if (!e2e) {
        done({ success: false });
        return;
      }
      e2e.projectStore
        .getState()
        .loadProject(openPath)
        .then(done)
        .catch(() => done({ success: false }));
    },
    p
  );
}

/** Plain export to an explicit path — does NOT touch the `.stalx` collab baseline. */
async function exportTmlTo(p: string): Promise<{ ok: boolean; error?: string }> {
  return browser.executeAsync(
    (tmlPath: string, done: (r: { ok: boolean; error?: string }) => void) => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: { getState: () => { exportTml: (path: string) => Promise<void> } };
        };
      }).__E2E_TEST__;
      if (!e2e) {
        done({ ok: false, error: 'E2E helpers not found' });
        return;
      }
      e2e.projectStore
        .getState()
        .exportTml(tmlPath)
        .then(() => done({ ok: true }))
        .catch((err) => done({ ok: false, error: String(err) }));
    },
    p
  );
}

/** Bump the first shot's length by `delta` (in-memory). */
async function editFirstShotLength(delta: number): Promise<{ success: boolean; error?: string }> {
  return browser.executeAsync(
    (d: number, done: (r: { success: boolean; error?: string }) => void) => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            getState: () => {
              project: { sections: Array<{ id: number; shots: Array<{ id: number; length: number }> }> } | null;
              updateShot: (
                sid: number,
                shotId: number,
                updates: { length: number }
              ) => Promise<{ success: boolean; error?: string }>;
            };
          };
        };
      }).__E2E_TEST__;
      if (!e2e) {
        done({ success: false, error: 'E2E helpers not found' });
        return;
      }
      const st = e2e.projectStore.getState();
      const sec = st.project?.sections[0];
      const shot = sec?.shots[0];
      if (!sec || !shot) {
        done({ success: false, error: 'no shot' });
        return;
      }
      st.updateShot(sec.id, shot.id, { length: shot.length + d })
        .then(done)
        .catch((err) => done({ success: false, error: String(err) }));
    },
    delta
  );
}

/** Rename the first section (in-memory). */
async function renameFirstSection(name: string): Promise<{ success: boolean; error?: string }> {
  return browser.executeAsync(
    (newName: string, done: (r: { success: boolean; error?: string }) => void) => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            getState: () => {
              project: { sections: Array<{ id: number }> } | null;
              updateSection: (sid: number, updates: { name: string }) => Promise<{ success: boolean; error?: string }>;
            };
          };
        };
      }).__E2E_TEST__;
      if (!e2e) {
        done({ success: false, error: 'E2E helpers not found' });
        return;
      }
      const st = e2e.projectStore.getState();
      const sec = st.project?.sections[0];
      if (!sec) {
        done({ success: false, error: 'no section' });
        return;
      }
      st.updateSection(sec.id, { name: newName })
        .then(done)
        .catch((err) => done({ success: false, error: String(err) }));
    },
    name
  );
}

/** Set a zero datum on a mid-station of the first section (→ pre-zero-datum leg). */
async function setMidStationDatum(): Promise<{ success: boolean; error?: string }> {
  return browser.executeAsync((done: (r: { success: boolean; error?: string }) => void) => {
    const e2e = (window as unknown as {
      __E2E_TEST__?: {
        projectStore: {
          getState: () => {
            project: { sections: Array<{ id: number; shots: unknown[] }> } | null;
            setZeroDatum: (
              stationRef: { section_id: number; station_index: number },
              gps: { latitude: number; longitude: number; depth_reference: number }
            ) => Promise<{ success: boolean; error?: string }>;
          };
        };
      };
    }).__E2E_TEST__;
    if (!e2e) {
      done({ success: false, error: 'E2E helpers not found' });
      return;
    }
    const st = e2e.projectStore.getState();
    const sec = st.project?.sections[0];
    if (!sec || sec.shots.length < 1) {
      done({ success: false, error: 'need a section with >=1 shot' });
      return;
    }
    st.setZeroDatum(
      { section_id: sec.id, station_index: 1 },
      { latitude: 20.0, longitude: -87.0, depth_reference: 10.0 }
    )
      .then(done)
      .catch((err) => done({ success: false, error: String(err) }));
  });
}

async function reviewDialogVisibleWithin(ms: number): Promise<boolean> {
  const dialog = await $('[data-testid="collab-review-dialog"]');
  try {
    await dialog.waitForDisplayed({ timeout: ms });
    return true;
  } catch {
    return false;
  }
}

async function totalLength(): Promise<number> {
  const stats = await getProjectStats();
  return stats?.totalLength ?? 0;
}

describe('Collaboration round-trip (fullstack)', () => {
  beforeEach(async () => {
    await waitForAppReady();
    await resetAppState();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stalagmight-collab-'));
  });

  afterEach(async () => {
    try {
      if (tempDir && fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  });

  it('writes a sibling .tml and a clean round-trip shows no review dialog', async () => {
    await createNewProject('Collab Clean');
    expect((await importDmpViaStore(DMP)).success).toBe(true);
    expect((await setCollabEnabled(true)).success).toBe(true);

    const projectPath = path.join(tempDir, 'clean.stalx');
    const sibling = path.join(tempDir, 'clean.tml');
    expect((await saveProjectTo(projectPath)).success).toBe(true);
    await waitForUiIdle(1000);
    expect(fs.existsSync(sibling)).toBe(true); // companion written on save

    await resetAppState();
    expect((await loadProjectFrom(projectPath)).success).toBe(true);
    await waitForUiIdle(1500);
    expect(await reviewDialogVisibleWithin(1500)).toBe(false); // no external edit → no dialog
  });

  it('detects, applies, and converges an external shot edit; apply is undoable', async () => {
    await createNewProject('Collab Edit');
    expect((await importDmpViaStore(DMP)).success).toBe(true);
    await setCollabEnabled(true);

    const projectPath = path.join(tempDir, 'edit.stalx');
    const sibling = path.join(tempDir, 'edit.tml');
    await saveProjectTo(projectPath);
    await waitForUiIdle(1000);
    const base = await totalLength();

    // External Ariane edit: bump the first shot, export over the sibling (the
    // .stalx baseline stays at `base`), then drop the in-memory edit.
    expect((await editFirstShotLength(5)).success).toBe(true);
    expect((await exportTmlTo(sibling)).ok).toBe(true);
    await resetAppState();

    // Reopen → reconcile detects the edit.
    expect((await loadProjectFrom(projectPath)).success).toBe(true);
    expect(await reviewDialogVisibleWithin(10000)).toBe(true);
    const editedCount = await $('[data-testid="collab-count-edited"]');
    expect(parseInt(await editedCount.getText(), 10)).toBeGreaterThanOrEqual(1);

    // Apply → the edit lands.
    await $('[data-testid="collab-review-apply"]').click();
    await waitForUiIdle(1500);
    expect(await totalLength()).toBeCloseTo(base + 5, 1);

    // Undo reverts the whole reconcile; redo re-applies.
    await undo();
    await waitForUiIdle(800);
    expect(await totalLength()).toBeCloseTo(base, 1);
    await redo();
    await waitForUiIdle(800);
    expect(await totalLength()).toBeCloseTo(base + 5, 1);

    // Persist + reopen → convergence (no dialog).
    await saveProjectTo(projectPath);
    await waitForUiIdle(1000);
    await resetAppState();
    expect((await loadProjectFrom(projectPath)).success).toBe(true);
    await waitForUiIdle(1500);
    expect(await reviewDialogVisibleWithin(1500)).toBe(false);
  });

  it('reconciles an external section rename as a metadata change (no destroy)', async () => {
    await createNewProject('Collab Rename');
    expect((await importDmpViaStore(DMP)).success).toBe(true);
    await setCollabEnabled(true);

    const projectPath = path.join(tempDir, 'rename.stalx');
    const sibling = path.join(tempDir, 'rename.tml');
    await saveProjectTo(projectPath);
    await waitForUiIdle(1000);
    const base = await totalLength();

    expect((await renameFirstSection('Renamed Passage')).success).toBe(true);
    expect((await exportTmlTo(sibling)).ok).toBe(true);
    await resetAppState();

    expect((await loadProjectFrom(projectPath)).success).toBe(true);
    expect(await reviewDialogVisibleWithin(10000)).toBe(true);
    // A rename is a section-meta change, with no shot removes/adds.
    const metaCount = await $('[data-testid="collab-count-section-meta"]');
    expect(parseInt(await metaCount.getText(), 10)).toBeGreaterThanOrEqual(1);
    expect(parseInt(await (await $('[data-testid="collab-count-removed"]')).getText(), 10)).toBe(0);
    expect(parseInt(await (await $('[data-testid="collab-count-added"]')).getText(), 10)).toBe(0);

    await $('[data-testid="collab-review-apply"]').click();
    await waitForUiIdle(1500);
    // Geometry is untouched by a rename.
    expect(await totalLength()).toBeCloseTo(base, 1);
  });

  it('georeferenced project (mid-station datum) clean round-trip shows no phantom section', async () => {
    await createNewProject('Collab Datum');
    expect((await importDmpViaStore(DMP)).success).toBe(true);
    expect((await setMidStationDatum()).success).toBe(true);
    await setCollabEnabled(true);

    const projectPath = path.join(tempDir, 'datum.stalx');
    await saveProjectTo(projectPath);
    await waitForUiIdle(1000);

    await resetAppState();
    expect((await loadProjectFrom(projectPath)).success).toBe(true);
    await waitForUiIdle(1500);
    // The synthetic pre-zero-datum leg must NOT surface as a change.
    expect(await reviewDialogVisibleWithin(1500)).toBe(false);
  });
});
