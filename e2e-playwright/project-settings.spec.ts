/**
 * E2E for the per-project settings dialog (#57): General (name) + Validation
 * thresholds, stored in the .stalx. Opened from the project overview.
 */
import { test, expect } from './fixtures/coverage';
import { setupMockedPage, createProject, seedProjectWithSections, waitForMapIdle, type SectionSeed } from './helpers/app';

const sectionSeeds: SectionSeed[] = [
  {
    name: 'Main',
    direction: 'in',
    shots: [{ azimuth_in: 45, azimuth_out: 225, length: 10, depth_in: -1, depth_out: -3 }],
  },
];

test.describe('Project Settings', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
  });

  test('edits per-project name + validation thresholds', async ({ page }) => {
    await createProject(page, 'Proj Settings');
    await seedProjectWithSections(page, sectionSeeds);
    await waitForMapIdle(page);

    // Project overview (no selection) on the Details tab carries the button.
    await page.getByTestId('detail-tab-details').click();
    await page.getByTestId('open-project-settings').click();
    await expect(page.getByTestId('project-settings-dialog')).toBeVisible();

    // General tab shows the project name.
    await expect(page.getByTestId('project-settings-name')).toHaveValue('Proj Settings');

    // Experimental tab hosts the Ariane collaboration toggle (moved here).
    await page.getByTestId('project-settings-tab-experimental').click();
    await expect(page.getByTestId('toggle-collaboration')).toBeVisible();

    // Validation tab exposes the same thresholds as the global settings.
    await page.getByTestId('project-settings-tab-validation').click();
    const minInput = page.getByTestId('input-shot-length-min');
    await expect(minInput).toBeVisible();
    await minInput.fill('2');

    await page.getByTestId('project-settings-save').click();
    await expect(page.getByTestId('project-settings-dialog')).toHaveCount(0);

    // The change is reflected in the project's per-project validation config.
    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __E2E_TEST__?: {
                  projectStore: {
                    getState: () => { project: { validation?: { warn_shot_length_min: number } } | null };
                  };
                };
              }
            ).__E2E_TEST__?.projectStore.getState().project?.validation?.warn_shot_length_min,
        ),
      )
      .toBe(2);
  });

  test('collab toggle is staged: Cancel discards, Save commits (#57)', async ({ page }) => {
    await createProject(page, 'Collab Staging');
    await seedProjectWithSections(page, sectionSeeds);
    await waitForMapIdle(page);

    const readCollabEnabled = () =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __E2E_TEST__?: {
                projectStore: {
                  getState: () => { project: { collab?: { enabled?: boolean } | null } | null };
                };
              };
            }
          ).__E2E_TEST__?.projectStore.getState().project?.collab?.enabled ?? false,
      );

    const openDialogToExperimental = async () => {
      await page.getByTestId('detail-tab-details').click();
      await page.getByTestId('open-project-settings').click();
      await expect(page.getByTestId('project-settings-dialog')).toBeVisible();
      await page.getByTestId('project-settings-tab-experimental').click();
      await expect(page.getByTestId('toggle-collaboration')).toBeVisible();
    };

    // --- Flow 1: toggle ON then Cancel -> discarded. ---
    await openDialogToExperimental();
    const toggle = page.getByTestId('toggle-collaboration');
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await page.getByTestId('project-settings-cancel').click();
    await expect(page.getByTestId('project-settings-dialog')).toHaveCount(0);

    // Persisted collab state untouched, and reopening shows OFF (staged value reset).
    expect(await readCollabEnabled()).toBeFalsy();
    await openDialogToExperimental();
    await expect(page.getByTestId('toggle-collaboration')).toHaveAttribute('aria-checked', 'false');
    await page.getByTestId('project-settings-cancel').click();
    await expect(page.getByTestId('project-settings-dialog')).toHaveCount(0);

    // --- Flow 2: toggle ON then Save -> committed. ---
    // The mock's set_collab_enabled is a no-op, so stub the store action to both
    // record the commit and reflect enabled=true in the project (as the real
    // backend would) so the reopened dialog seeds ON.
    await page.evaluate(() => {
      const store = (
        window as unknown as {
          __E2E_TEST__: {
            projectStore: {
              getState: () => { project: { collab?: unknown } | null };
              setState: (p: unknown) => void;
            };
          };
        }
      ).__E2E_TEST__.projectStore;
      store.setState({
        setCollabEnabled: async (enabled: boolean) => {
          const cur = store.getState().project;
          if (cur) {
            store.setState({
              project: {
                ...cur,
                collab: {
                  enabled,
                  sibling_tml_relative: 'collab-staging.tml',
                  last_export_tml_sha256: null,
                  shot_baseline: [],
                  section_name_map: [],
                  synthetic_section_names: [],
                  last_reconcile_at: null,
                  write_tml_on_autosave: false,
                },
              },
            });
          }
          return { success: true, warnings: [], error: null, section_ids: [] };
        },
      });
    });

    await openDialogToExperimental();
    await expect(page.getByTestId('toggle-collaboration')).toHaveAttribute('aria-checked', 'false');
    await page.getByTestId('toggle-collaboration').click();
    await page.getByTestId('project-settings-save').click();
    await expect(page.getByTestId('project-settings-dialog')).toHaveCount(0);

    expect(await readCollabEnabled()).toBe(true);
    await openDialogToExperimental();
    await expect(page.getByTestId('toggle-collaboration')).toHaveAttribute('aria-checked', 'true');
  });
});
