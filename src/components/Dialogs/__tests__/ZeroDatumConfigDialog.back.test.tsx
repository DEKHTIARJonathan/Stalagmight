/**
 * #534: `ZeroDatumConfigDialog`'s OWN Back (to `zero-datum-selection`, not
 * the wizard's) discarded `previousZeroDatumConfig` - the config #394 F10
 * already carries one hop - so Back-to-selection-and-forward started blank,
 * and because a re-seeded dialog opens CLEAN, no dirty prompt warned about
 * the loss.
 *
 * The fix lives in App.tsx's dialog routing (not in either dialog
 * component), so this exercises that routing directly: a small harness
 * mirroring App.tsx's `zero-datum-selection` / `zero-datum-config` blocks
 * (the `onBack` around line 845 and `onSelectSection` around line 825),
 * driven by the REAL `uiStore` the same way App.tsx is. Keep this in sync
 * with App.tsx if that routing changes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useUIStore } from '../../../store/uiStore';
import type { ZeroDatumConfigResult } from '../ZeroDatumConfigDialog';

function carriedConfig(sectionIndex: number): ZeroDatumConfigResult {
  return {
    sectionIndex,
    stationIndex: 0,
    gps: { latitude: 20.25, longitude: -87.5, depth_reference: 0 },
    metadata: {
      name: 'Typed Name',
      surveyor: 'Typed Surveyor',
      date: '2025-12-24',
      color: '#123456',
      direction: 'out',
      quality: 1,
      reverse: true,
    },
    shots: [],
  };
}

/** Mirrors App.tsx's two dialog blocks for this flow, stubbed to expose the
 *  props under test as clickable buttons instead of full dialog UIs. */
function Harness() {
  const activeDialog = useUIStore((s) => s.activeDialog);
  const dialogData = useUIStore((s) => s.dialogData);
  const openDialog = useUIStore((s) => s.openDialog);

  return (
    <>
      {activeDialog === 'zero-datum-selection' ? (
        <div>
          <button
            data-testid="select-section-0"
            onClick={() => {
              const carried = dialogData.previousZeroDatumConfig as ZeroDatumConfigResult | undefined;
              openDialog('zero-datum-config', {
                zeroDatumSectionIndex: 0,
                previousZeroDatumConfig: carried?.sectionIndex === 0 ? carried : undefined,
              });
            }}
          />
          <button
            data-testid="select-section-1"
            onClick={() => {
              const carried = dialogData.previousZeroDatumConfig as ZeroDatumConfigResult | undefined;
              openDialog('zero-datum-config', {
                zeroDatumSectionIndex: 1,
                previousZeroDatumConfig: carried?.sectionIndex === 1 ? carried : undefined,
              });
            }}
          />
        </div>
      ) : null}
      {activeDialog === 'zero-datum-config' ? (
        <div>
          <span data-testid="config-initial-name">
            {(dialogData.previousZeroDatumConfig as ZeroDatumConfigResult | undefined)?.metadata.name ?? ''}
          </span>
          <button
            data-testid="config-back"
            onClick={() => {
              openDialog('zero-datum-selection', {
                previousZeroDatumConfig: dialogData.previousZeroDatumConfig,
              });
            }}
          />
        </div>
      ) : null}
    </>
  );
}

describe('zero-datum-config Back-to-selection carry (#534)', () => {
  beforeEach(() => {
    useUIStore.setState({ activeDialog: null, dialogData: {} });
  });

  /**
   * Injection: drop the `previousZeroDatumConfig: dialogData.previousZeroDatumConfig`
   * relay from the config dialog's `onBack` (pass `{}` instead) - the selection
   * dialog then has nothing to hand back, and the reopened config dialog shows ''.
   */
  it('Back-to-selection then same-section-forward shows the carried values', () => {
    useUIStore.getState().openDialog('zero-datum-config', {
      zeroDatumSectionIndex: 0,
      previousZeroDatumConfig: carriedConfig(0),
    });
    render(<Harness />);

    fireEvent.click(screen.getByTestId('config-back'));
    fireEvent.click(screen.getByTestId('select-section-0'));

    expect(screen.getByTestId('config-initial-name')).toHaveTextContent('Typed Name');
  });

  /**
   * Injection: drop the `carried?.sectionIndex === sectionIndex ?` guard in
   * `onSelectSection` (always carry `carried`) - a different section pick
   * then still shows 'Typed Name'.
   */
  it('Back-to-selection then different-section-forward starts fresh', () => {
    useUIStore.getState().openDialog('zero-datum-config', {
      zeroDatumSectionIndex: 0,
      previousZeroDatumConfig: carriedConfig(0),
    });
    render(<Harness />);

    fireEvent.click(screen.getByTestId('config-back'));
    fireEvent.click(screen.getByTestId('select-section-1'));

    expect(screen.getByTestId('config-initial-name')).toHaveTextContent('');
  });

  /**
   * Injection: seed the selection dialog's `dialogData` with a leftover
   * `previousZeroDatumConfig` on a fresh open (i.e. drop `openDialog`'s
   * wholesale `dialogData` replacement) - a genuine first visit would then
   * carry a stale config into the config dialog too.
   */
  it('a genuine first visit into the selection dialog carries nothing', () => {
    useUIStore.getState().openDialog('zero-datum-selection', {});
    render(<Harness />);

    fireEvent.click(screen.getByTestId('select-section-0'));

    expect(screen.getByTestId('config-initial-name')).toHaveTextContent('');
  });
});
