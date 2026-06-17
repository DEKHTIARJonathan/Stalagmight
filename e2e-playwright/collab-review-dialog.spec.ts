import { test, expect, type Page } from './fixtures/coverage';
import {
  setupMockedPage,
  createProject,
  seedProjectWithSections,
  waitForMapReady,
  waitForNoDialogs,
} from './helpers/app';

/**
 * E2E tests for collaboration mode:
 *  - the Collaboration settings category (project-scoped toggle)
 *  - the Collaboration Review dialog rendering + Apply/Cancel wiring
 *
 * The review dialog is normally opened on project open when the sibling
 * Ariane (.tml) file was edited externally. Here we drive it directly via the
 * UI store with a synthetic change set so the component can be exercised under
 * mocked IPC (apply_collab_changes is mocked to succeed).
 */

function shotData(over: Record<string, unknown> = {}) {
  return {
    azimuth_in: 90,
    azimuth_out: 90,
    length: 10,
    depth_in: -5,
    depth_out: -6,
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
    ...over,
  };
}

function emptyImpact(sectionId: number) {
  return {
    removed_station: { section_id: sectionId, station_index: 3 },
    removed_merges: [],
    removed_closures: [],
    replacement_merges: [],
    replacement_closure_updates: [],
    merge_rewire_skipped: false,
    closure_rewire_skipped: false,
    shift_blocked: false,
    shift_blocked_reasons: [],
  };
}

function sampleChangeSet(sectionId: number) {
  return {
    shots_added: [
      { section_id: sectionId, section_name: 'Main Line', position: 4, after_shot_id: null, data: shotData({ length: 12 }) },
    ],
    shots_edited: [
      {
        section_id: sectionId,
        shot_index: 1,
        section_name: 'Main Line',
        changes: [{ field: 'length', old: '10.00', new: '11.50' }],
        new_data: shotData({ length: 11.5 }),
      },
    ],
    shots_removed: [
      { section_id: sectionId, shot_index: 2, section_name: 'Main Line', impact: emptyImpact(sectionId) },
    ],
    sections_added: [
      { name: 'New Branch', color: '#4ecdc4', surveyor: null, date: null, shots: [shotData()] },
    ],
    section_meta_changed: [
      {
        section_id: sectionId,
        section_name: 'Main Line',
        changes: [{ field: 'color', old: '#ff6b6b', new: '#4ecdc4' }],
      },
    ],
    warnings: [{ message: 'Some shots were matched by geometry.' }],
    match_quality: 'Fingerprint',
  };
}

async function openProject(page: Page): Promise<number> {
  await setupMockedPage(page);
  await createProject(page, 'Collab Test');
  await seedProjectWithSections(page, [
    { name: 'Main Line', direction: 'in', shots: [
      { azimuth_in: 90, azimuth_out: 90, length: 10, depth_in: -5, depth_out: -6 },
      { azimuth_in: 90, azimuth_out: 90, length: 10, depth_in: -6, depth_out: -7 },
      { azimuth_in: 90, azimuth_out: 90, length: 10, depth_in: -7, depth_out: -8 },
    ] },
  ]);
  await waitForMapReady(page);
  await waitForNoDialogs(page);

  const sectionId = await page.evaluate(() => {
    const e2e = (window as unknown as {
      __E2E_TEST__?: { projectStore: { getState: () => { project: { sections: { id: number }[] } } } };
    }).__E2E_TEST__;
    return e2e!.projectStore.getState().project.sections[0].id;
  });
  return sectionId;
}

async function openReviewDialog(page: Page, sectionId: number) {
  await page.evaluate((cs) => {
    (window as unknown as {
      __E2E_TEST__: { uiStore: { getState: () => { openDialog: (n: string, d: Record<string, unknown>) => void } } };
    }).__E2E_TEST__.uiStore.getState().openDialog('collab-review', { changeSet: cs });
  }, sampleChangeSet(sectionId) as unknown as Record<string, unknown>);
}

test.describe('Collaboration Review Dialog', () => {
  test('renders change summary, lists, and match-quality banner', async ({ page }) => {
    const sectionId = await openProject(page);
    await openReviewDialog(page, sectionId);

    const dialog = page.getByTestId('collab-review-dialog');
    await expect(dialog).toBeVisible();

    await expect(page.getByTestId('collab-count-added')).toHaveText('1');
    await expect(page.getByTestId('collab-count-edited')).toHaveText('1');
    await expect(page.getByTestId('collab-count-removed')).toHaveText('1');
    await expect(page.getByTestId('collab-count-sections')).toHaveText('1');
    await expect(page.getByTestId('collab-count-section-meta')).toHaveText('1');

    await expect(page.getByTestId('collab-added-list')).toBeVisible();
    await expect(page.getByTestId('collab-edited-list')).toBeVisible();
    await expect(page.getByTestId('collab-removed-list')).toBeVisible();
    await expect(page.getByTestId('collab-sections-list')).toBeVisible();
    await expect(page.getByTestId('collab-section-meta-list')).toBeVisible();

    // Fingerprint match quality shows the advisory banner + warnings.
    await expect(page.getByTestId('collab-match-quality')).toBeVisible();
    await expect(page.getByTestId('collab-warnings')).toBeVisible();
  });

  test('Apply invokes apply_collab_changes and closes', async ({ page }) => {
    const sectionId = await openProject(page);

    const calls: string[] = [];
    await page.exposeFunction('__recordCollabApply', () => calls.push('apply'));
    // Hook the store action to record the apply call.
    await page.evaluate(() => {
      const store = (window as unknown as {
        __E2E_TEST__: { projectStore: { getState: () => { applyCollabChanges: () => Promise<unknown> }, setState: (p: unknown) => void } };
      }).__E2E_TEST__.projectStore;
      const orig = store.getState().applyCollabChanges;
      store.setState({
        applyCollabChanges: async () => {
          (window as unknown as { __recordCollabApply: () => void }).__recordCollabApply();
          return orig();
        },
      });
    });

    await openReviewDialog(page, sectionId);
    const dialog = page.getByTestId('collab-review-dialog');
    await expect(dialog).toBeVisible();

    await page.getByTestId('collab-review-apply').click();
    await expect(dialog).not.toBeVisible({ timeout: 5000 });
    expect(calls).toContain('apply');
  });

  test('Cancel closes without applying', async ({ page }) => {
    const sectionId = await openProject(page);
    await openReviewDialog(page, sectionId);

    const dialog = page.getByTestId('collab-review-dialog');
    await expect(dialog).toBeVisible();

    await page.getByTestId('collab-review-cancel').click();
    await expect(dialog).not.toBeVisible({ timeout: 5000 });
  });
});

test.describe('Collaboration toggle (Project Settings)', () => {
  test('the per-project toggle lives in Project Settings → Experimental and invokes set_collab_enabled', async ({ page }) => {
    await openProject(page);

    // The toggle moved into the Project Settings dialog's Experimental tab (#57).
    await page.getByTestId('detail-tab-details').click();
    await page.getByTestId('open-project-settings').click();
    await expect(page.getByTestId('project-settings-dialog')).toBeVisible();
    await page.getByTestId('project-settings-tab-experimental').click();
    await expect(page.getByTestId('collaboration-section')).toBeVisible();

    const toggle = page.getByTestId('toggle-collaboration');
    await expect(toggle).toBeVisible();

    const calls: string[] = [];
    await page.exposeFunction('__recordSetCollab', () => calls.push('set'));
    await page.evaluate(() => {
      const store = (window as unknown as {
        __E2E_TEST__: { projectStore: { getState: () => { setCollabEnabled: (e: boolean) => Promise<unknown> }, setState: (p: unknown) => void } };
      }).__E2E_TEST__.projectStore;
      const orig = store.getState().setCollabEnabled;
      store.setState({
        setCollabEnabled: async (enabled: boolean) => {
          (window as unknown as { __recordSetCollab: () => void }).__recordSetCollab();
          return orig(enabled);
        },
      });
    });

    await toggle.click();
    await expect.poll(() => calls.length).toBeGreaterThan(0);
  });
});
