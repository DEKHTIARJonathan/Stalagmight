import { test, expect } from './fixtures/coverage';
import {
  setupMockedPage,
  createProject,
  waitForActiveTool,
  waitForMapIdle,
} from './helpers/app';

test.describe('Large Dataset Operations', () => {
  test('keeps core interactions responsive with a large seeded project', async ({ page }) => {
    await setupMockedPage(page);
    await createProject(page, 'Large Dataset Scenario');

    await page.evaluate(async () => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            getState: () => {
              project: Record<string, unknown> | null;
              refreshProjectState: () => Promise<void>;
            };
            setState: (partial: Record<string, unknown>) => void;
          };
        };
        __E2E_MOCKS__?: {
          setCurrentProject: (project: unknown) => void;
        };
      }).__E2E_TEST__;

      const mocks = (window as unknown as {
        __E2E_MOCKS__?: {
          setCurrentProject: (project: unknown) => void;
        };
      }).__E2E_MOCKS__;

      if (!e2e?.projectStore || !mocks?.setCurrentProject) {
        throw new Error('E2E project hooks unavailable');
      }

      const state = e2e.projectStore.getState();
      const baseProject = state.project;
      if (!baseProject) {
        throw new Error('Project must exist before seeding large dataset');
      }

      const sections: Array<Record<string, unknown>> = [];
      for (let sectionId = 1; sectionId <= 24; sectionId += 1) {
        const shots: Array<Record<string, unknown>> = [];
        for (let shotId = 1; shotId <= 40; shotId += 1) {
          shots.push({
            id: shotId,
            azimuth_in: (sectionId * 12 + shotId * 3) % 360,
            azimuth_out: (sectionId * 12 + shotId * 3) % 360,
            length: 3 + (shotId % 5),
            depth_in: -(shotId * 0.15),
            depth_out: -((shotId + 1) * 0.15),
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
          });
        }

        sections.push({
          id: sectionId,
          name: `Dataset Section ${sectionId}`,
          surveyor: 'Load Tester',
          date: '2026-02-10',
          color: sectionId % 2 === 0 ? '#4a90d9' : '#22c55e',
          direction: 'in',
          shots,
        });
      }

      const nextProject = {
        ...baseProject,
        sections,
        station_merges: [],
        zero_datums: [
          {
            station_ref: { section_id: 1, station_index: 0 },
            gps: { latitude: 24.55, longitude: -81.78, depth_reference: 0 },
          },
        ],
        loop_closures: [],
        section_offsets: {},
      };

      mocks.setCurrentProject(nextProject);
      e2e.projectStore.setState({ project: nextProject });
      await e2e.projectStore.getState().refreshProjectState();
    });

    await expect(page.locator('[data-testid^="section-row-"]')).toHaveCount(24);

    await page.getByTestId('section-row-24').click();
    await page.keyboard.press('Control+3');
    await expect(page.getByTestId('data-table')).toBeVisible({ timeout: 10000 });

    await page.keyboard.press('z');
    await waitForActiveTool(page, 'zoom');

    await page.keyboard.press('p');
    await waitForActiveTool(page, 'pan');

    await page.keyboard.press('f');
    await waitForMapIdle(page);

    await page.keyboard.press('Control+e');
    await expect(page.getByTestId('export-dialog')).toBeVisible({ timeout: 5000 });
    await page.getByTestId('export-type-image').click();
    await expect(page.getByTestId('export-preview')).toBeVisible({ timeout: 10000 });
  });
});
