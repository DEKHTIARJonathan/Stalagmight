/**
 * Reverse Section end-to-end (#24).
 *
 * Covers the three menu surfaces that expose the action, the confirm dialog's
 * left/right choice, the multi-select entry, and the Edit Section dialog's
 * disabled-while-dirty rule.
 */
import { test, expect, type Page } from './fixtures/coverage';
import {
  setupMockedPage,
  createProject,
  seedProjectWithSections,
  waitForMapReady,
  waitForNoDialogs,
} from './helpers/app';
import type { E2EWindow } from './helpers/e2eWindow';
import type { CommandError } from '../src/types/ipc/CommandError';

type StationRef = { section_id: number; station_index: number };

/**
 * Every field the reverse touches differs from every other, so a wrong transform
 * cannot look like a right one:
 *
 * * `azimuth_in !== azimuth_out` - the transform reciprocates AND swaps them, so
 *   an equal pair could not tell a correct reverse from one that only
 *   reciprocates (or only swaps).
 * * `depth_in !== depth_out` and `pitch_in !== -pitch_out` - both are swapped,
 *   and pitch is negated as well.
 * * `left !== right` - swapped only when the user opts in.
 *
 * Values are exactly representable in float32: the mock round-trips shots through
 * the binary IPC wire (`load_project_full_binary`), so 0.1 would come back a few
 * ulps off and every assertion below would need a tolerance.
 */
function buildShot(index: number) {
  const base = index + 1;
  return {
    azimuth_in: 10 * base,
    azimuth_out: 10 * base + 6,
    length: 5 + base,
    depth_in: -1 * base,
    depth_out: -1.5 * base,
    pitch_in: 2 * base,
    pitch_out: -(base + 0.5),
    left: 0.5 * base,
    right: 0.75 * base,
    up: 0.25 * base,
    down: 0.5 + base,
  };
}

/** Reciprocal of a forward azimuth, normalised to [0, 360) - `reverse.rs::reciprocal`. */
function reciprocal(azimuth: number): number {
  return (((azimuth + 180) % 360) + 360) % 360;
}

async function setup(page: Page, sectionCount = 1) {
  await setupMockedPage(page);
  await createProject(page, 'Reverse Section');

  await seedProjectWithSections(
    page,
    Array.from({ length: sectionCount }, (_, s) => ({
      name: `Section ${s + 1}`,
      direction: 'in' as const,
      shots: Array.from({ length: 3 }, (_, idx) => buildShot(idx + s * 3)),
    }))
  );

  await waitForMapReady(page);
  await waitForNoDialogs(page);

  const ids = await page.evaluate(() => {
    const state = (window as E2EWindow).__E2E_TEST__.projectStore.getState();
    return (state.project?.sections ?? []).map((s) => s.id) as number[];
  });
  if (ids.length !== sectionCount) {
    throw new Error(`Expected ${sectionCount} sections, got ${ids.length}`);
  }
  return ids;
}

async function openContextMenu(page: Page, target: Record<string, unknown>) {
  await page.evaluate(
    ({ target }) => {
      (window as E2EWindow).__E2E_TEST__.uiStore.getState().openDialog('context-menu', {
        target,
        position: { x: 140, y: 140 },
      });
    },
    { target }
  );
}

type ShotSnapshot = {
  id: number;
  length: number;
  azimuth_in: number;
  azimuth_out: number;
  depth_in: number;
  depth_out: number;
  pitch_in: number | null;
  pitch_out: number | null;
  left: number | null;
  right: number | null;
};

async function readShots(page: Page, sectionId: number): Promise<ShotSnapshot[]> {
  return page.evaluate((id) => {
    const state = (window as E2EWindow).__E2E_TEST__.projectStore.getState();
    const section = state.project!.sections.find((s) => s.id === id);
    return (section?.shots ?? []).map((s) => ({
      id: s.id,
      length: s.length,
      azimuth_in: s.azimuth_in,
      azimuth_out: s.azimuth_out,
      depth_in: s.depth_in,
      depth_out: s.depth_out,
      pitch_in: s.pitch_in,
      pitch_out: s.pitch_out,
      left: s.left,
      right: s.right,
    }));
  }, sectionId);
}

/** The section's map anchor, which a reverse must move to keep the cave still. */
async function readSectionOffset(page: Page, sectionId: number): Promise<[number, number]> {
  return page.evaluate((id) => {
    const state = (window as E2EWindow).__E2E_TEST__.projectStore.getState();
    const offsets = state.project?.section_offsets ?? {};
    const entry = Array.isArray(offsets)
      ? (offsets as Array<[number, [number, number]]>).find(([k]) => Number(k) === id)?.[1]
      : (offsets as Record<string, [number, number]>)[String(id)];
    return (entry ?? [0, 0]) as [number, number];
  }, sectionId);
}

async function readComment(
  page: Page,
  sectionId: number,
  stationIndex: number
): Promise<string | undefined> {
  return page.evaluate(
    ({ id, index }) => {
      const state = (window as E2EWindow).__E2E_TEST__.projectStore.getState();
      return (state.stations ?? []).find(
        (s) =>
          s.station_ref.section_id === id && s.station_ref.station_index === index
      )?.comment as string | undefined;
    },
    { id: sectionId, index: stationIndex }
  );
}

async function reverseFromSectionMenu(page: Page, sectionId: number): Promise<void> {
  await openContextMenu(page, { type: 'section', sectionId });
  await page.getByRole('button', { name: 'Reverse Section' }).click();
  const dialog = page.getByTestId('reverse-section-dialog');
  await expect(dialog).toBeVisible();
  await page.getByTestId('reverse-confirm').click();
  await expect(dialog).not.toBeVisible({ timeout: 5000 });
  await waitForNoDialogs(page);
}

test.describe('Reverse Section', () => {
  test('is offered from the sections panel, map station and map shot menus', async ({ page }) => {
    const [sectionId] = await setup(page);
    const shotIds = await page.evaluate((id) => {
      const state = (window as E2EWindow).__E2E_TEST__.projectStore.getState();
      return state.project!.sections
        .find((s) => s.id === id)!
        .shots.map((s) => s.id);
    }, sectionId);

    for (const target of [
      { type: 'section', sectionId },
      { type: 'station', ref: { section_id: sectionId, station_index: 0 } as StationRef },
      { type: 'shot', sectionId, shotId: shotIds[0] },
    ]) {
      await openContextMenu(page, target);
      await expect(page.getByRole('button', { name: 'Reverse Section' })).toBeVisible();
      await page.keyboard.press('Escape');
      await waitForNoDialogs(page);
    }
  });

  test('is absent from the shot-scoped datatable menu', async ({ page }) => {
    const [sectionId] = await setup(page);
    const shotIds = await page.evaluate((id) => {
      const state = (window as E2EWindow).__E2E_TEST__.projectStore.getState();
      return state.project!.sections.find((s) => s.id === id)!.shots.map((s) => s.id);
    }, sectionId);

    await openContextMenu(page, {
      type: 'datatable-shot',
      sectionId,
      shotId: shotIds[1],
      isFirst: false,
      isLast: false,
      totalShots: 3,
      sectionName: 'Section 1',
    });
    await expect(page.getByRole('button', { name: 'Reverse Section' })).toHaveCount(0);
  });

  test('reverses shot order and leaves left/right alone by default', async ({ page }) => {
    const [sectionId] = await setup(page);
    const before = await readShots(page, sectionId);

    await openContextMenu(page, { type: 'section', sectionId });
    await page.getByRole('button', { name: 'Reverse Section' }).click();

    const dialog = page.getByTestId('reverse-section-dialog');
    await expect(dialog).toBeVisible();
    // The left/right choice is present and starts unticked.
    await expect(page.getByTestId('reverse-swap-lr')).not.toBeChecked();
    await page.getByTestId('reverse-confirm').click();
    await expect(dialog).not.toBeVisible({ timeout: 5000 });

    await expect.poll(async () => (await readShots(page, sectionId)).map((s) => s.length)).toEqual(
      before.map((s) => s.length).reverse()
    );

    const after = await readShots(page, sectionId);
    // Ids stay attached to positions; the records moved under them.
    expect(after.map((s) => s.id)).toEqual(before.map((s) => s.id));
    // Left/right untouched: the last shot's values are now on the first row.
    expect(after[0]!.left).toBe(before[before.length - 1]!.left);
    expect(after[0]!.right).toBe(before[before.length - 1]!.right);
  });

  test('swaps left/right when the user opts in', async ({ page }) => {
    const [sectionId] = await setup(page);
    const before = await readShots(page, sectionId);
    const lastBefore = before[before.length - 1]!;

    await openContextMenu(page, { type: 'section', sectionId });
    await page.getByRole('button', { name: 'Reverse Section' }).click();
    await page.getByTestId('reverse-swap-lr').check();
    await page.getByTestId('reverse-confirm').click();
    await expect(page.getByTestId('reverse-section-dialog')).not.toBeVisible({ timeout: 5000 });

    await expect.poll(async () => (await readShots(page, sectionId))[0]!.left).toBe(
      lastBefore.right
    );
    const after = await readShots(page, sectionId);
    expect(after[0]!.right).toBe(lastBefore.left);
  });

  test('reciprocates and swaps the readings, swaps depths and negates pitch', async ({ page }) => {
    // The per-field transform (models/project/reverse.rs). Every test above reads
    // only `length` and `left`/`right`, so the whole reciprocate-and-swap - the
    // part that actually keeps the cave still - was unasserted: a reverse that
    // merely re-ordered the shots passed them all.
    const [sectionId] = await setup(page);
    const before = await readShots(page, sectionId);

    await reverseFromSectionMenu(page, sectionId);
    await expect
      .poll(async () => (await readShots(page, sectionId)).map((s) => s.length))
      .toEqual(before.map((s) => s.length).reverse());

    const after = await readShots(page, sectionId);
    expect(after).toHaveLength(before.length);
    after.forEach((shot, i) => {
      const source = before[before.length - 1 - i]!;
      // azimuth_in/out are two FORWARD readings of the same line, not a
      // foresight/backsight pair - so they are reciprocated AND swapped.
      // Swapping alone leaves the circular mean (the bearing geometry walks)
      // untouched and the section pointing the way it did before.
      expect(shot.azimuth_in).toBeCloseTo(reciprocal(source.azimuth_out), 4);
      expect(shot.azimuth_out).toBeCloseTo(reciprocal(source.azimuth_in), 4);
      expect(shot.depth_in).toBeCloseTo(source.depth_out, 5);
      expect(shot.depth_out).toBeCloseTo(source.depth_in, 5);
      // Pitch is signed slope, so travelling the other way flips it as well as
      // re-associating it with the other end.
      expect(shot.pitch_in).toBeCloseTo(-source.pitch_out!, 5);
      expect(shot.pitch_out).toBeCloseTo(-source.pitch_in!, 5);
      // Not opted in, so left/right travel with the record untouched.
      expect(shot.left).toBeCloseTo(source.left!, 5);
      expect(shot.right).toBeCloseTo(source.right!, 5);
    });
  });

  test('swaps every shot left/right when the user opts in, and nothing else', async ({ page }) => {
    const [sectionId] = await setup(page);
    const before = await readShots(page, sectionId);

    await openContextMenu(page, { type: 'section', sectionId });
    await page.getByRole('button', { name: 'Reverse Section' }).click();
    await page.getByTestId('reverse-swap-lr').check();
    await page.getByTestId('reverse-confirm').click();
    await expect(page.getByTestId('reverse-section-dialog')).not.toBeVisible({ timeout: 5000 });
    await expect
      .poll(async () => (await readShots(page, sectionId)).map((s) => s.length))
      .toEqual(before.map((s) => s.length).reverse());

    const after = await readShots(page, sectionId);
    after.forEach((shot, i) => {
      const source = before[before.length - 1 - i]!;
      expect(shot.left).toBeCloseTo(source.right!, 5);
      expect(shot.right).toBeCloseTo(source.left!, 5);
      // The opt-in is left/right ONLY - up/down are absolute and never mirror,
      // and the azimuth transform is unaffected by the choice.
      expect(shot.azimuth_in).toBeCloseTo(reciprocal(source.azimuth_out), 4);
    });
  });

  test('swaps readings exactly 180 apart instead of reciprocating them', async ({ page }) => {
    // A pair exactly 180 apart has an undefined circular mean, and
    // reciprocate-and-swap maps it to ITSELF - the shot would keep its old
    // bearing while the rest of the section turned around, which is the one way
    // a reverse can move the cave. `reverse_shots` swaps such a pair instead.
    //
    // The second section is the same degenerate pair written out of range, which
    // only reads as degenerate once both readings are normalised to [0, 360)
    // first - and, because that branch swaps its operands verbatim, only comes
    // back in range if the normalisation happened before the swap. Reachable:
    // validation only WARNS on an out-of-range azimuth and the DMP parser stores
    // headings verbatim.
    await setupMockedPage(page);
    await createProject(page, 'Reverse Antipodal');
    await seedProjectWithSections(page, [
      {
        name: 'Antipodal',
        direction: 'in',
        shots: [{ azimuth_in: 30, azimuth_out: 210, length: 10, depth_in: 0, depth_out: 0 }],
      },
      {
        name: 'Antipodal, out of range',
        direction: 'in',
        shots: [{ azimuth_in: 30, azimuth_out: -150, length: 10, depth_in: 0, depth_out: 0 }],
      },
    ]);
    await waitForMapReady(page);
    await waitForNoDialogs(page);

    const ids = await page.evaluate(() =>
      ((window as E2EWindow).__E2E_TEST__.projectStore.getState().project?.sections ?? []).map(
        (s) => s.id as number
      )
    );
    expect(ids).toHaveLength(2);

    for (const id of ids) {
      await reverseFromSectionMenu(page, id);
      // Swapped, not reciprocated: reciprocate-and-swap would hand back the
      // original (30, 210) unchanged.
      await expect.poll(async () => (await readShots(page, id))[0]!.azimuth_in).toBe(210);
      expect((await readShots(page, id))[0]!.azimuth_out).toBe(30);
    }
  });

  test('compensates the anchor with the true circular mean of out-of-range readings', async ({
    page,
  }) => {
    // 600 degrees is 240; paired with 0 the true circular mean is 300, the short
    // way round. Rust's `%` - and JS's - truncate toward zero and return the
    // ANTIPODE 120 for a pair this far apart, which is the bug #24 fixed in
    // `average_azimuth_of`. The anchor compensation would then point the wrong
    // way and the passage would jump by twice its own span on every reverse.
    await setupMockedPage(page);
    await createProject(page, 'Reverse Out Of Range');
    await seedProjectWithSections(page, [
      {
        name: 'Far out of range',
        direction: 'in',
        shots: [{ azimuth_in: 600, azimuth_out: 0, length: 10, depth_in: 0, depth_out: 0 }],
      },
    ]);
    await waitForMapReady(page);
    await waitForNoDialogs(page);

    const sectionId = await page.evaluate(
      () => (window as E2EWindow).__E2E_TEST__.projectStore.getState().project!.sections[0].id as number
    );
    const offsetBefore = await readSectionOffset(page, sectionId);

    await reverseFromSectionMenu(page, sectionId);

    const meanRad = (300 * Math.PI) / 180;
    await expect
      .poll(async () => (await readSectionOffset(page, sectionId))[0] - offsetBefore[0])
      .toBeCloseTo(10 * Math.sin(meanRad), 4);
    const offsetAfter = await readSectionOffset(page, sectionId);
    expect(offsetAfter[1] - offsetBefore[1]).toBeCloseTo(10 * Math.cos(meanRad), 4);
  });

  test('never writes a non-finite section offset', async ({ page }) => {
    // `NaN !== 0` is TRUE, so a bare "did it move?" check admits a non-finite
    // displacement into `section_offsets`, which has no other finite guard - and
    // save rewrites a non-finite offset to 0.0, teleporting the section to the
    // origin (the exact opposite of what the compensation is for). A finite
    // length is enough to produce one: squaring 1e200 overflows to Infinity, and
    // `Infinity * sin(0)` is NaN.
    await setupMockedPage(page);
    await createProject(page, 'Reverse Overflow');
    await seedProjectWithSections(page, [
      {
        name: 'Overflowing',
        direction: 'in',
        shots: [{ azimuth_in: 0, azimuth_out: 0, length: 1e200, depth_in: 0, depth_out: 0 }],
      },
    ]);
    await waitForMapReady(page);
    await waitForNoDialogs(page);

    const sectionId = await page.evaluate(
      () => (window as E2EWindow).__E2E_TEST__.projectStore.getState().project!.sections[0].id as number
    );

    await reverseFromSectionMenu(page, sectionId);

    const offset = await readSectionOffset(page, sectionId);
    expect(Number.isFinite(offset[0])).toBe(true);
    expect(Number.isFinite(offset[1])).toBe(true);
  });

  test('writes the anchor without clobbering a neighbouring section', async ({ page }) => {
    // `section_offsets` reaches the backend-facing mock in two shapes: the JS
    // Record the create/import paths build, and the `[sectionId, [dx, dy]]` pairs
    // the binary load path (and `__E2E_MOCKS__.setCurrentProject`) carry.
    // `offsets["2"] = [dx, dy]` on the pair form sets ELEMENT 2 - silently
    // replacing another section's entry with a bare coordinate.
    const ids = await setup(page, 2);
    await page.evaluate((sectionIds) => {
      const project = (window as E2EWindow).__E2E_MOCKS__!.getCurrentProject()!;
      project.section_offsets = [
        [sectionIds[0], [1, 2]],
        [sectionIds[1], [3, 4]],
      ];
    }, ids);

    await reverseFromSectionMenu(page, ids[0]!);

    // The reversed section's anchor moved...
    await expect
      .poll(async () => (await readSectionOffset(page, ids[0]!))[0])
      .not.toBe(1);
    // ...and its neighbour's is exactly as it was.
    expect(await readSectionOffset(page, ids[1]!)).toEqual([3, 4]);
  });

  test('offers a separate entry for a multi-section selection', async ({ page }) => {
    const ids = await setup(page, 2);

    await page.evaluate((sectionIds) => {
      const ui = (window as E2EWindow).__E2E_TEST__.uiStore.getState();
      ui.setSelection({ type: 'section', sectionId: sectionIds[0] });
      ui.addToSelection({ type: 'section', sectionId: sectionIds[1] });
    }, ids);

    await openContextMenu(page, { type: 'section', sectionId: ids[0] });
    await expect(page.getByRole('button', { name: 'Reverse Section', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reverse 2 Sections' })).toBeVisible();

    await page.getByRole('button', { name: 'Reverse 2 Sections' }).click();
    const dialog = page.getByTestId('reverse-section-dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('reverse-section-list').locator('li')).toHaveCount(2);
  });

  test('reverses every selected section as one batched action', async ({ page }) => {
    const ids = await setup(page, 2);
    const before = await Promise.all(ids.map((id) => readShots(page, id)));

    await page.evaluate((sectionIds) => {
      const ui = (window as E2EWindow).__E2E_TEST__.uiStore.getState();
      ui.setSelection({ type: 'section', sectionId: sectionIds[0] });
      ui.addToSelection({ type: 'section', sectionId: sectionIds[1] });
    }, ids);

    await openContextMenu(page, { type: 'section', sectionId: ids[0] });
    await page.getByRole('button', { name: 'Reverse 2 Sections' }).click();
    await expect(page.getByTestId('reverse-section-dialog')).toBeVisible();
    await page.getByTestId('reverse-confirm').click();
    await waitForNoDialogs(page);

    // Both sections reversed, not just the first.
    for (const [i, id] of ids.entries()) {
      const after = await readShots(page, id);
      expect(after.map((s) => s.length)).toEqual(
        [...before[i]!].reverse().map((s) => s.length)
      );
    }

    // One batch, carrying both sections - not one command per section, which
    // would half-apply on failure and need one Undo each.
    const batches = await page.evaluate(
      () => (window as E2EWindow).__MOCK_EXECUTE_BATCH_CALLS__ as unknown[] | undefined
    );
    expect(batches).toHaveLength(1);
    expect(batches![0]).toHaveLength(2);
  });

  test('moves the anchor and the station comment with the section', async ({ page }) => {
    // The dialog promises "the cave does not move ... comments stay on the
    // station they were set on". Both live outside the shot vec, so a reverse
    // that only reciprocated the shots would pass every test above.
    const [sectionId] = await setup(page);

    await page.evaluate(
      (id) =>
        (window as E2EWindow).__E2E_TEST__.projectStore
          .getState()
          .updateStationComment({ section_id: id, station_index: 0 }, 'at the entrance'),
      sectionId
    );
    await expect
      .poll(() => readComment(page, sectionId, 0))
      .toBe('at the entrance');

    const offsetBefore = await readSectionOffset(page, sectionId);

    await reverseFromSectionMenu(page, sectionId);

    // Station 0 is now the far end, so the anchor gained the section's span.
    const offsetAfter = await readSectionOffset(page, sectionId);
    expect(offsetAfter).not.toEqual(offsetBefore);

    // The comment travelled to the same physical station, now numbered 3.
    await expect.poll(() => readComment(page, sectionId, 3)).toBe('at the entrance');
    expect(await readComment(page, sectionId, 0)).toBeUndefined();

    // And reversing back restores both - the transform is its own inverse.
    await reverseFromSectionMenu(page, sectionId);
    await expect.poll(() => readComment(page, sectionId, 0)).toBe('at the entrance');
    const offsetRestored = await readSectionOffset(page, sectionId);
    expect(offsetRestored[0]).toBeCloseTo(offsetBefore[0], 9);
    expect(offsetRestored[1]).toBeCloseTo(offsetBefore[1], 9);
  });

  test('shift-clicking sections panel rows reaches the multi-section entry', async ({ page }) => {
    // The multi entry is gated on `multiSelection` holding >1 section, and the
    // sections panel is the ONLY affordance that can produce that - every other
    // addToSelection call site emits a station or a shot. Driven through real
    // clicks rather than page.evaluate, so it proves the entry is reachable.
    const ids = await setup(page, 2);

    await page.getByTestId(`section-row-${ids[0]}`).click();
    await page.getByTestId(`section-row-${ids[1]}`).click({ modifiers: ['Shift'] });

    await openContextMenu(page, { type: 'section', sectionId: ids[0] });
    await expect(page.getByRole('button', { name: 'Reverse 2 Sections' })).toBeVisible();
  });

  test('ctrl-clicking sections panel rows toggles them in and out of the selection', async ({
    page,
  }) => {
    // The ctrl/meta branch of `handleSectionClick` is a behaviour change to an
    // existing widget (#24) and no other spec modifier-clicks a section row.
    // Unlike Shift's addToSelection, it TOGGLES - a second ctrl-click removes
    // the row again, which is what drops the menu back to the single entry.
    const ids = await setup(page, 2);
    const selectedSectionIds = () =>
      page.evaluate(() =>
        ((window as E2EWindow).__E2E_TEST__.uiStore.getState().multiSelection ?? [])
          .filter((s) => s.type === 'section')
          .map((s) => s.sectionId as number)
      );

    await page.getByTestId(`section-row-${ids[0]}`).click();
    await page.getByTestId(`section-row-${ids[1]}`).click({ modifiers: ['ControlOrMeta'] });
    expect(await selectedSectionIds()).toEqual([ids[0], ids[1]]);

    await openContextMenu(page, { type: 'section', sectionId: ids[0] });
    await expect(page.getByRole('button', { name: 'Reverse 2 Sections' })).toBeVisible();
    // Dismissed through the store rather than Escape: the Escape shortcut also
    // CLEARS the selection, which would hide whether the second ctrl-click below
    // toggled the row off or the keypress did it.
    await page.evaluate(() => (window as E2EWindow).__E2E_TEST__.uiStore.getState().closeDialog());
    await waitForNoDialogs(page);

    await page.getByTestId(`section-row-${ids[1]}`).click({ modifiers: ['ControlOrMeta'] });
    expect(await selectedSectionIds()).toEqual([ids[0]]);

    await openContextMenu(page, { type: 'section', sectionId: ids[0] });
    await expect(page.getByRole('button', { name: 'Reverse Section', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /Reverse \d+ Sections/ })).toHaveCount(0);
  });

  test('offers only the single entry for a section outside the multi-selection', async ({
    page,
  }) => {
    // Right-clicking a section that is NOT part of the selection must act on the
    // section under the cursor alone - offering "Reverse 2 Sections" there would
    // reverse two sections the user never pointed at.
    const ids = await setup(page, 3);

    await page.evaluate((sectionIds) => {
      const ui = (window as E2EWindow).__E2E_TEST__.uiStore.getState();
      ui.setSelection({ type: 'section', sectionId: sectionIds[0] });
      ui.addToSelection({ type: 'section', sectionId: sectionIds[1] });
    }, ids);

    await openContextMenu(page, { type: 'section', sectionId: ids[2] });
    await expect(page.getByRole('button', { name: 'Reverse Section', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /Reverse \d+ Sections/ })).toHaveCount(0);

    // And it reverses only the section that was right-clicked.
    await page.getByRole('button', { name: 'Reverse Section', exact: true }).click();
    await expect(page.getByTestId('reverse-section-list').locator('li')).toHaveCount(1);
    await expect(page.getByTestId('reverse-section-list')).toContainText('Section 3');
  });

  test('counts a repeated section in the selection once', async ({ page }) => {
    // The menu dedupes `multiSelection` before counting: a repeated id would
    // reverse that section twice in the batch (the second a silent no-op) and
    // inflate the count the label promises. The store's own add/toggle paths
    // dedupe, so the duplicate is injected directly.
    const ids = await setup(page, 2);

    await page.evaluate((sectionIds) => {
      (window as E2EWindow).__E2E_TEST__.uiStore.setState({
        selection: { type: 'section', sectionId: sectionIds[0] },
        multiSelection: [
          { type: 'section', sectionId: sectionIds[0] },
          { type: 'section', sectionId: sectionIds[1] },
          { type: 'section', sectionId: sectionIds[0] },
        ],
      });
    }, ids);

    await openContextMenu(page, { type: 'section', sectionId: ids[0] });
    await expect(page.getByRole('button', { name: 'Reverse 2 Sections' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Reverse 3 Sections/ })).toHaveCount(0);

    await page.getByRole('button', { name: 'Reverse 2 Sections' }).click();
    await expect(page.getByTestId('reverse-section-list').locator('li')).toHaveCount(2);
    await expect(page.getByTestId('reverse-confirm')).toHaveText('Reverse 2 Sections');
  });

  test('surfaces a rejected reverse and leaves the dialog open to retry', async ({ page }) => {
    // The read-only self-check has its own test; this is the OTHER error surface -
    // a refusal from the backend (a `CommandError` rejection), whose message must
    // render verbatim rather than closing the dialog on a reverse that never happened.
    const [sectionId] = await setup(page);
    const before = await readShots(page, sectionId);

    await page.evaluate(() => {
      (window as E2EWindow).__MOCK_IPC_OVERRIDES__ = {
        reverse_section: { __reject: { code: 'FAILED', message: 'Section is locked by another editor' } satisfies CommandError },
      };
    });

    await openContextMenu(page, { type: 'section', sectionId });
    await page.getByRole('button', { name: 'Reverse Section' }).click();
    await page.getByTestId('reverse-confirm').click();

    await expect(page.getByTestId('reverse-error')).toHaveText('Section is locked by another editor');
    await expect(page.getByTestId('reverse-section-dialog')).toBeVisible();
    // Re-armed, so the user can retry once the cause is cleared.
    await expect(page.getByTestId('reverse-confirm')).toBeEnabled();
    expect((await readShots(page, sectionId)).map((s) => s.length)).toEqual(
      before.map((s) => s.length)
    );
  });

  test('Cancel closes the dialog without reversing anything', async ({ page }) => {
    const [sectionId] = await setup(page);
    const before = await readShots(page, sectionId);
    await page.evaluate(() =>
      (window as E2EWindow).__E2E_TEST__.projectStore.setState({ isDirty: false })
    );

    await openContextMenu(page, { type: 'section', sectionId });
    await page.getByRole('button', { name: 'Reverse Section' }).click();
    const dialog = page.getByTestId('reverse-section-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    await expect(dialog).not.toBeVisible();
    expect((await readShots(page, sectionId)).map((s) => s.length)).toEqual(
      before.map((s) => s.length)
    );
    // Nothing was submitted, so the project is still clean.
    expect(
      await page.evaluate(
        () => (window as E2EWindow).__E2E_TEST__.projectStore.getState().isDirty as boolean
      )
    ).toBe(false);
  });

  test('moves the gas plan pins with the sections they sit on', async ({ page }) => {
    // Plan pins are positional StationRefs the backend cannot reach, so a reverse
    // leaves them in range while they name the opposite physical station - the
    // plan would silently re-price a different route.
    const [sectionId] = await setup(page);

    await page.evaluate((id) => {
      const gas = (window as E2EWindow).__E2E_TEST__.gasPlanStore.getState();
      gas.setOrigin({ section_id: id, station_index: 0 });
      gas.setEndpoint({ section_id: id, station_index: 1 });
    }, sectionId);

    await reverseFromSectionMenu(page, sectionId);

    const pins = await page.evaluate(() => {
      const gas = (window as E2EWindow).__E2E_TEST__.gasPlanStore.getState();
      return { origin: gas.origin, endpoint: gas.endpoint };
    });
    // 3 shots -> 4 stations: 0 mirrors to 3, 1 mirrors to 2.
    expect(pins.origin).toEqual({ section_id: sectionId, station_index: 3 });
    expect(pins.endpoint).toEqual({ section_id: sectionId, station_index: 2 });
  });

  test('moves the loaded-plan baseline with the pins, so the plan stays clean', async ({
    page,
  }) => {
    // The baseline holds the same POSITIONAL refs as the live pins. Mirroring one without the
    // other makes selectIsPlanDirty compare two different numberings and report a plan the
    // diver never edited as unsaved - nagging a save, or blocking a plan switch, over a route
    // that is still the same physical route.
    const [sectionId] = await setup(page);

    await page.evaluate((id) => {
      const gas = (window as E2EWindow).__E2E_TEST__.gasPlanStore.getState();
      const origin = { section_id: id, station_index: 0 };
      gas.setOrigin(origin);
      gas.applyLoadedPlan(1, {
        origin,
        endpoint: null,
        waypoints: [],
        segments: [],
        diver: gas.diver,
        cylinders: gas.cylinders,
        gas_config: gas.gasConfig,
        stage_drop_overrides: [],
        marked_points: [],
      });
    }, sectionId);

    await reverseFromSectionMenu(page, sectionId);

    const after = await page.evaluate(() => {
      const gas = (window as E2EWindow).__E2E_TEST__.gasPlanStore.getState();
      return { origin: gas.origin, baseline: gas.loadedPlanBaseline?.origin ?? null };
    });
    expect(after.origin).toEqual({ section_id: sectionId, station_index: 3 });
    expect(after.baseline).toEqual({ section_id: sectionId, station_index: 3 });
  });

  test('clears the selection and any half-staged merge', async ({ page }) => {
    // Unlike the pins there is no "same place" for a highlight or a half-picked merge: a
    // staged operation that silently retargets the far end is worse than one the user has to
    // restart, so these are CLEARED rather than mirrored.
    const [sectionId] = await setup(page);

    await page.evaluate((id) => {
      const ui = (window as E2EWindow).__E2E_TEST__.uiStore.getState();
      ui.setSelection({ type: 'section', sectionId: id });
      ui.setMergeStationA({ section_id: id, station_index: 0 });
    }, sectionId);

    // Precondition: both are actually set, so the assertions below cannot pass vacuously.
    const before = await page.evaluate(() => {
      const ui = (window as E2EWindow).__E2E_TEST__.uiStore.getState();
      return { selection: ui.selection, mergeStationA: ui.mergeStationA };
    });
    expect(before.selection).not.toBeNull();
    expect(before.mergeStationA).not.toBeNull();

    await reverseFromSectionMenu(page, sectionId);

    const after = await page.evaluate(() => {
      const ui = (window as E2EWindow).__E2E_TEST__.uiStore.getState();
      return { selection: ui.selection, mergeStationA: ui.mergeStationA };
    });
    expect(after.selection).toBeNull();
    expect(after.mergeStationA).toBeNull();
  });

  test('moves the distance-gradient origin with the section too', async ({ page }) => {
    // Same positional-ref hazard as the plan pins, and the origin's only other
    // reset is a project switch - so without this the penetration ramp silently
    // re-roots from the opposite end while still looking correct.
    const [sectionId] = await setup(page);

    await page.evaluate((id) => {
      (window as E2EWindow).__E2E_TEST__.uiStore
        .getState()
        .setDistanceGradientOrigin({ section_id: id, station_index: 0 });
    }, sectionId);

    await reverseFromSectionMenu(page, sectionId);

    const origin = await page.evaluate(
      () => (window as E2EWindow).__E2E_TEST__.uiStore.getState().distanceGradientOrigin
    );
    expect(origin).toEqual({ section_id: sectionId, station_index: 3 });
  });

  test('refuses to confirm while the view is read-only', async ({ page }) => {
    // The closure-adjusted / Plan / Export read-only mode has NO server backstop,
    // and the mode can flip while the dialog is up - so the check has to run at
    // confirm time, not at open time.
    const [sectionId] = await setup(page);
    const before = await readShots(page, sectionId);

    await page.evaluate((id) => {
      const ui = (window as E2EWindow).__E2E_TEST__.uiStore.getState();
      ui.openDialog('reverse-section', { sectionIds: [id] });
      ui.setAppMode('plan');
    }, sectionId);

    await expect(page.getByTestId('reverse-section-dialog')).toBeVisible();
    await page.getByTestId('reverse-confirm').click();

    await expect(page.getByTestId('reverse-error')).toBeVisible();
    // The dialog stays up and nothing was reversed.
    await expect(page.getByTestId('reverse-section-dialog')).toBeVisible();
    expect((await readShots(page, sectionId)).map((s) => s.length)).toEqual(
      before.map((s) => s.length)
    );
  });

  test('disables confirm when a listed section has gone away', async ({ page }) => {
    // The count, the label and the submitted batch all come off the RESOLVED
    // sections, so a section deleted between opening the menu and confirming
    // can't show "Reverse 2 Sections" over a 1-item list and then fail the whole
    // batch.
    const ids = await setup(page, 2);

    await page.evaluate((sectionIds) => {
      (window as E2EWindow).__E2E_TEST__.uiStore
        .getState()
        .openDialog('reverse-section', { sectionIds });
    }, ids);
    await expect(page.getByTestId('reverse-section-dialog')).toBeVisible();
    await expect(page.getByTestId('reverse-confirm')).toHaveText('Reverse 2 Sections');

    await page.evaluate(
      (id) => (window as E2EWindow).__E2E_TEST__.projectStore.getState().deleteSection(id),
      ids[1]
    );

    await expect(page.getByTestId('reverse-section-list').locator('li')).toHaveCount(1);
    await expect(page.getByTestId('reverse-confirm')).toHaveText('Reverse');
    await expect(page.getByTestId('reverse-confirm')).toBeDisabled();
    await expect(page.getByTestId('reverse-stale')).toBeVisible();
  });

  test('does not dirty the project for a section with no shots', async ({ page }) => {
    // A section with no shots is a single station and reverses to itself, so the
    // backend deliberately changes nothing - sending it anyway would cost an
    // unsaved-changes marker (and an Undo) for a provable no-op.
    await setupMockedPage(page);
    await createProject(page, 'Reverse Empty');
    await seedProjectWithSections(page, [{ name: 'Empty', direction: 'in', shots: [] }]);
    await waitForMapReady(page);
    await waitForNoDialogs(page);

    const sectionId = await page.evaluate(
      () => (window as E2EWindow).__E2E_TEST__.projectStore.getState().project!.sections[0].id as number
    );
    await page.evaluate(() =>
      (window as E2EWindow).__E2E_TEST__.projectStore.setState({ isDirty: false })
    );

    // The dialog now REFUSES rather than submitting a no-op: with nothing that would
    // actually change, Confirm is disabled, so the user is not offered an action that
    // would close the dialog and fire a completed-reverse event having done nothing.
    await page.evaluate((id) => {
      (window as E2EWindow).__E2E_TEST__.uiStore
        .getState()
        .openDialog('reverse-section', { sectionIds: [id] });
    }, sectionId);
    await expect(page.getByTestId('reverse-section-dialog')).toBeVisible();
    await expect(page.getByTestId('reverse-confirm')).toBeDisabled();

    await page.evaluate(() => (window as E2EWindow).__E2E_TEST__.uiStore.getState().closeDialog());

    expect(
      await page.evaluate(
        () => (window as E2EWindow).__E2E_TEST__.projectStore.getState().isDirty as boolean
      )
    ).toBe(false);
  });

  test('Edit Section dialog disables Reverse only while dirty', async ({ page }) => {
    const [sectionId] = await setup(page);

    await page.evaluate((id) => {
      (window as E2EWindow).__E2E_TEST__.uiStore.getState().openDialog('edit-section', { sectionId: id });
    }, sectionId);
    await expect(page.getByTestId('edit-section-dialog')).toBeVisible();

    const reverseButton = page.getByTestId('edit-section-reverse');
    await expect(reverseButton).toBeEnabled();

    // Dirty the dialog via its section-name field.
    await page.getByTestId('section-name-input').fill('Renamed while editing');
    await expect(reverseButton).toBeDisabled();
    await expect(reverseButton).toHaveAttribute('title', /Save or discard/);
  });
});
