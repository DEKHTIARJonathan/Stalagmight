/**
 * #576 W4: where the DMP wizard puts each failure of its run, and what it offers
 * next. The wizard used to keep ONE error string for every step, written by
 * eleven call sites and rendered by whichever panel happened to be on screen -
 * so some failures had no panel at all (a blank window) and others landed
 * behind a dialog. Each case here is a failure the user could not see, or could
 * not act on, before.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, act } from '@testing-library/react';

// SectionPreview and the map panel pull maplibre-gl (WebGL) at module load,
// which jsdom cannot execute. Nothing here asserts on anything drawn.
vi.mock('../SectionPreview', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../SectionPreview')>()),
  default: () => null,
}));
vi.mock('maplibre-gl', () => ({ default: {} }));
vi.mock('../WizardMapPanel', () => ({
  WizardMapPanel: () => null,
  MAP_PANEL_DEFAULT_WIDTH: 400,
  MAP_PANEL_MAX_WIDTH: 800,
}));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
  }),
}));
vi.mock('../../../utils/telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/telemetry')>()),
  trackDialogComplete: vi.fn(),
  setSource: vi.fn(),
}));

const invokeIpcMock = vi.fn();
vi.mock('../../../utils/ipc', () => ({
  invokeIpc: (...args: unknown[]) => invokeIpcMock(...args),
  getErrorMessage: (e: unknown, fallback?: string) =>
    e instanceof Error ? e.message : typeof e === 'string' ? e : (fallback ?? String(e)),
}));

import { receipt, renderWizard, zeroDatumOn0 } from './dmpWizardHarness';
import { useUIStore } from '../../../store/uiStore';
import { useProjectStore } from '../../../store/projectStore';

/** What `import_sections` answers with; `null` = success with fresh ids. */
let importAnswer: Record<string, unknown> | Error | null = null;
/** What `suggest_all_import_placements` does on each call, in order. */
let suggestAnswers: Array<unknown[] | Error> = [];
let ipcOrder: string[] = [];
let nextSectionId = 7;

beforeEach(() => {
  importAnswer = null;
  suggestAnswers = [];
  ipcOrder = [];
  nextSectionId = 7;
  invokeIpcMock.mockReset();
  invokeIpcMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    ipcOrder.push(cmd);
    if (cmd === 'import_sections') {
      if (importAnswer instanceof Error) throw importAnswer;
      if (importAnswer) return importAnswer;
      const configs = (args?.sections as unknown[] | undefined) ?? [];
      return { success: true, section_ids: configs.map(() => nextSectionId++), import_receipt: receipt(), warnings: [] };
    }
    if (cmd === 'suggest_all_import_placements') {
      const answer = suggestAnswers.shift() ?? [];
      if (answer instanceof Error) throw answer;
      return answer;
    }
    return null;
  });
  useUIStore.setState({ activeDialog: null, dialogData: {}, placementMode: null, importContext: null, toasts: [] });
  useProjectStore.setState({ project: null });
});

afterEach(async () => {
  await act(async () => {});
});

/**
 * NF-AN4-N1. Phase `init` had no error view: the zero-datum import failing left
 * the wizard's body empty - a blank window with Cancel and Back and no word of
 * what went wrong.
 */
describe('DMP wizard: a failure while the wizard starts is shown (#576 NF-AN4-N1)', () => {
  it('shows the backend refusal of the zero-datum import', async () => {
    importAnswer = { success: false, error: 'Anchor refused (test)', section_ids: [], warnings: [] };
    renderWizard(undefined, { selected: [0, 1], zeroDatumConfig: zeroDatumOn0() });

    await waitFor(() => expect(screen.getByTestId('wizard-error')).toHaveTextContent('Anchor refused (test)'));
    expect(screen.getByTestId('wizard-error')).toBeVisible();
    // The way out is open: nothing is in flight.
    expect(screen.getByTestId('cancel-button')).toBeEnabled();
    expect(screen.getByTestId('back-button')).toBeEnabled();
  });

  it('shows a thrown zero-datum import too', async () => {
    importAnswer = new Error('disk unplugged (test)');
    renderWizard(undefined, { selected: [0, 1], zeroDatumConfig: zeroDatumOn0() });

    await waitFor(() => expect(screen.getByTestId('wizard-error')).toHaveTextContent('disk unplugged (test)'));
  });
});
