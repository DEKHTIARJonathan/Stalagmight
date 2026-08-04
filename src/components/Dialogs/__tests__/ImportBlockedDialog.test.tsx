/**
 * #407 follow-up: the Plan/Export mode-only DMP rejection is a choice, not an
 * error. "Switch to Survey" must flip the mode AND continue importing the
 * already-picked file (completing the dialog so the telemetry source survives);
 * "Stay in Plan/Export" must close without touching the mode, and its label
 * must name the mode that raised the prompt.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const closeDialog = vi.fn();
const setAppMode = vi.fn();
const routeOpenedFile = vi.fn();
const trackDialogComplete = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

let appMode = 'plan';
const dialogData: { path?: string } = {};

vi.mock('../../../store/uiStore', () => ({
  useUIStore: (sel: (s: unknown) => unknown) => sel({ closeDialog, setAppMode, dialogData, appMode }),
}));

vi.mock('../../../utils/openOrImport', () => ({
  routeOpenedFile: (...args: unknown[]) => routeOpenedFile(...args),
}));

vi.mock('../../../utils/telemetry', () => ({
  trackDialogComplete: (...args: unknown[]) => trackDialogComplete(...args),
}));

vi.mock('../DialogWrapper', () => ({
  DialogWrapper: ({ title, children, 'data-testid': testId }: { title: string; children: React.ReactNode; 'data-testid'?: string }) => (
    <div data-testid={testId}>
      <h2>{title}</h2>
      {children}
    </div>
  ),
}));

import ImportBlockedDialog from '../ImportBlockedDialog';

beforeEach(() => {
  vi.clearAllMocks();
  appMode = 'plan';
  dialogData.path = '/cave/survey.dmp';
});

describe('ImportBlockedDialog', () => {
  it('"Switch to Survey" completes the dialog, switches the mode, and re-routes the picked file', () => {
    render(<ImportBlockedDialog />);
    fireEvent.click(screen.getByTestId('import-blocked-switch'));
    expect(trackDialogComplete).toHaveBeenCalledWith('import-blocked');
    expect(closeDialog).toHaveBeenCalled();
    expect(setAppMode).toHaveBeenCalledWith('survey');
    // residualReadOnlyToast: a cause that survives the switch (e.g. restored
    // closure-adjusted view) must toast, not raise a second modal.
    expect(routeOpenedFile).toHaveBeenCalledWith('/cave/survey.dmp', 'Import Failed', {
      residualReadOnlyToast: true,
    });
  });

  it('"Stay" closes without switching the mode or routing anything', () => {
    render(<ImportBlockedDialog />);
    fireEvent.click(screen.getByTestId('import-blocked-stay'));
    expect(closeDialog).toHaveBeenCalled();
    expect(setAppMode).not.toHaveBeenCalled();
    expect(routeOpenedFile).not.toHaveBeenCalled();
    // Not completed - closeDialog's cancel hook owns dropping the source.
    expect(trackDialogComplete).not.toHaveBeenCalled();
  });

  it('names the mode that raised it: Stay in Plan vs Stay in Export', () => {
    const { unmount } = render(<ImportBlockedDialog />);
    expect(screen.getByTestId('import-blocked-stay').textContent).toBe('dialogs.importBlocked.stayInPlan');
    unmount();
    appMode = 'export';
    render(<ImportBlockedDialog />);
    expect(screen.getByTestId('import-blocked-stay').textContent).toBe('dialogs.importBlocked.stayInExport');
  });

  it('a missing path still switches the mode but routes nothing (no crash)', () => {
    delete dialogData.path;
    render(<ImportBlockedDialog />);
    fireEvent.click(screen.getByTestId('import-blocked-switch'));
    expect(setAppMode).toHaveBeenCalledWith('survey');
    expect(routeOpenedFile).not.toHaveBeenCalled();
  });
});
