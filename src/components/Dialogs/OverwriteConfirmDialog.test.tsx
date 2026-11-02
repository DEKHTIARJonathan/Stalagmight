/**
 * Component test - the Save As overwrite confirm reads its body copy from the
 * locale (#576 RV2-FE-5, decision D20-D1), in both variants: the file exists, or
 * the existence probe failed and the dialog must not claim it does (E10-D1).
 * The keys are read back from i18n, so a hard-coded sentence fails here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import i18n from '../../i18n';
import OverwriteConfirmDialog from './OverwriteConfirmDialog';
import { useUIStore } from '../../store/uiStore';

vi.mock('../../hooks/useProject', () => ({ useProject: () => ({ handleCloseProject: vi.fn() }) }));

/** The translated sentence with its markup stripped, as the DOM shows it. */
const plain = (key: string, fileName?: string) =>
  i18n.t(key, { fileName }).replace(/<\/?name>/g, '');

beforeEach(() => {
  useUIStore.setState({ closeDialog: vi.fn(), dialogData: { path: '/x/CaveA.stalx', fileName: 'CaveA.stalx' } });
});

describe('OverwriteConfirmDialog copy', () => {
  it('the file exists: the locale sentence names it, in emphasis, and the locale warning follows', () => {
    render(<OverwriteConfirmDialog />);
    const message = screen.getByTestId('overwrite-confirm-message');
    expect(message).toHaveTextContent(plain('dialogs.overwriteConfirm.message', 'CaveA.stalx'));
    expect(message.querySelector('span')).toHaveTextContent('CaveA.stalx');
    expect(screen.getByText(i18n.t('dialogs.overwriteConfirm.warning'))).toBeInTheDocument();
    expect(screen.queryByTestId('overwrite-confirm-unknown')).toBeNull();
  });

  it('existence unknown: the "could not check" sentence and warning come from the locale', () => {
    useUIStore.setState({
      dialogData: { path: '/x/CaveA.stalx', fileName: 'CaveA.stalx', existenceUnknown: true },
    });
    render(<OverwriteConfirmDialog />);
    const message = screen.getByTestId('overwrite-confirm-unknown');
    expect(message).toHaveTextContent(plain('dialogs.overwriteConfirm.messageUnknown', 'CaveA.stalx'));
    expect(message.querySelector('span')).toHaveTextContent('CaveA.stalx');
    expect(screen.getByText(i18n.t('dialogs.overwriteConfirm.warningUnknown'))).toBeInTheDocument();
    // It must not claim the file is there.
    expect(message).not.toHaveTextContent(/already exists\. Do you want/);
  });

  it('the four keys exist in the locale (a missing key would render its own path)', () => {
    for (const key of ['message', 'messageUnknown', 'warning', 'warningUnknown']) {
      expect(i18n.exists(`dialogs.overwriteConfirm.${key}`), key).toBe(true);
    }
  });
});
