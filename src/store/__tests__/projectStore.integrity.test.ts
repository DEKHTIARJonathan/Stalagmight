import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useProjectStore } from '../projectStore';

const invokeIpcMock = vi.hoisted(() => vi.fn());

vi.mock('../../utils/ipc', () => ({
  invokeIpc: invokeIpcMock,
}));

// closeProject dynamically imports the features worker client; stub it so the
// test doesn't pull in the map/worker stack.
vi.mock('../../components/Map/surveyLayer/featuresWorkerClient', () => ({
  terminateFeaturesWorker: () => {},
}));

describe('projectStore integrity banner dismiss lifecycle', () => {
  let issues: string[];
  let saveBlocked: boolean;

  beforeEach(() => {
    vi.clearAllMocks();
    issues = [];
    saveBlocked = false;
    invokeIpcMock.mockImplementation(async (command: string) => {
      // check_project_integrity returns IntegrityCheckResult { messages, save_blocked }.
      if (command === 'check_project_integrity') return { messages: issues, save_blocked: saveBlocked };
      return undefined;
    });
    useProjectStore.setState({
      integrityIssues: [],
      integrityDismissed: false,
      integritySaveBlocked: false,
    });
  });

  it('keeps the banner dismissed across a re-check with the same issue set', async () => {
    // A detect-only issue surfaces on load.
    issues = ['drifted loop closure'];
    await useProjectStore.getState().checkProjectIntegrity();
    expect(useProjectStore.getState().integrityIssues).toEqual(['drifted loop closure']);
    expect(useProjectStore.getState().integrityDismissed).toBe(false);

    // The user dismisses the banner — issues stay populated, only the flag flips.
    useProjectStore.getState().dismissIntegrityIssues();
    expect(useProjectStore.getState().integrityDismissed).toBe(true);
    expect(useProjectStore.getState().integrityIssues).toEqual(['drifted loop closure']);

    // A save (or failed autosave) re-checks with the SAME set: must stay dismissed
    // — previously this resurrected the banner the user just dismissed.
    await useProjectStore.getState().checkProjectIntegrity();
    expect(useProjectStore.getState().integrityDismissed).toBe(true);
  });

  it('re-shows the banner when a genuinely new issue appears', async () => {
    issues = ['drifted loop closure'];
    await useProjectStore.getState().checkProjectIntegrity();
    useProjectStore.getState().dismissIntegrityIssues();
    expect(useProjectStore.getState().integrityDismissed).toBe(true);

    // A different issue set resets the dismissal so the new problem is seen.
    issues = ['drifted loop closure', 'dangling merge'];
    await useProjectStore.getState().checkProjectIntegrity();
    expect(useProjectStore.getState().integrityDismissed).toBe(false);
  });

  it('does not carry a dismissal across a project switch (identical messages)', async () => {
    // Two different projects can produce byte-identical issue messages (section
    // ids start at 0 in every project), so a dismissal must NOT leak across a
    // switch and suppress the new project's real banner.
    const msg = 'Section 0 has a shot with a non-finite (NaN/inf) value (at index 0)';
    issues = [msg];
    await useProjectStore.getState().checkProjectIntegrity();
    useProjectStore.getState().dismissIntegrityIssues();
    expect(useProjectStore.getState().integrityDismissed).toBe(true);

    // Closing the project must reset the integrity state.
    invokeIpcMock.mockImplementation(async (command: string) => {
      if (command === 'close_project') return { success: true };
      if (command === 'check_project_integrity') return { messages: issues, save_blocked: saveBlocked };
      return undefined;
    });
    await useProjectStore.getState().closeProject();
    expect(useProjectStore.getState().integrityIssues).toEqual([]);
    expect(useProjectStore.getState().integrityDismissed).toBe(false);

    // Opening a different project whose check returns the IDENTICAL message must
    // show its banner (dismissal did not leak).
    await useProjectStore.getState().checkProjectIntegrity();
    expect(useProjectStore.getState().integrityIssues).toEqual([msg]);
    expect(useProjectStore.getState().integrityDismissed).toBe(false);
  });

  it('keeps the dismissal across a re-check that only reorders the messages', async () => {
    // The backend's message order isn't stable (HashMap iteration); a reorder of
    // the same set must not resurface a dismissed banner.
    issues = ['orphan offset A', 'orphan comment B'];
    await useProjectStore.getState().checkProjectIntegrity();
    useProjectStore.getState().dismissIntegrityIssues();
    expect(useProjectStore.getState().integrityDismissed).toBe(true);

    // Same set, different order.
    issues = ['orphan comment B', 'orphan offset A'];
    await useProjectStore.getState().checkProjectIntegrity();
    expect(useProjectStore.getState().integrityDismissed).toBe(true);
  });

  it('tracks save-blocked state from the check result', async () => {
    // A save-blocking (unresolvable cross-reference) project sets the flag; the
    // banner uses it to stay non-dismissable (App gates on integritySaveBlocked).
    issues = ['Merge references a deleted station'];
    saveBlocked = true;
    await useProjectStore.getState().checkProjectIntegrity();
    expect(useProjectStore.getState().integritySaveBlocked).toBe(true);
    // Even if the user clicks Dismiss, the App banner ignores it while blocked;
    // here we just assert the flag the App reads is set.
    useProjectStore.getState().dismissIntegrityIssues();
    expect(useProjectStore.getState().integritySaveBlocked).toBe(true);

    // Once repaired (issues gone, not blocked), the flag clears.
    issues = [];
    saveBlocked = false;
    await useProjectStore.getState().checkProjectIntegrity();
    expect(useProjectStore.getState().integritySaveBlocked).toBe(false);
  });

  it('re-checks integrity after undo so the banner is not stale', async () => {
    // Start clean (e.g. just after a Repair).
    issues = [];
    saveBlocked = false;
    await useProjectStore.getState().checkProjectIntegrity();
    expect(useProjectStore.getState().integrityIssues).toEqual([]);

    // Undoing the Repair restores the dangling ref: the next integrity check
    // reports it, and undo must re-run that check (otherwise the banner stays
    // stale showing "clean" while the project is broken).
    issues = ['Merge anchor no longer resolves in section 0'];
    saveBlocked = true;
    invokeIpcMock.mockImplementation(async (command: string) => {
      if (command === 'undo') return { success: true };
      if (command === 'get_project_state') return null; // refreshProjectState
      if (command === 'check_project_integrity') return { messages: issues, save_blocked: saveBlocked };
      return undefined;
    });

    await useProjectStore.getState().undo();

    expect(useProjectStore.getState().integrityIssues).toEqual([
      'Merge anchor no longer resolves in section 0',
    ]);
    expect(useProjectStore.getState().integritySaveBlocked).toBe(true);
  });
});
