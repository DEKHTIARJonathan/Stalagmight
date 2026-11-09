import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import { LeftWorkspace } from '../LeftWorkspace';
import { SpeleoNetworkBusyIndicator, SPELEO_NETWORK_BUSY_LABEL } from '../SpeleoNetworkBusyIndicator';
import { useSpeleoNetworkStore } from '../../../store/speleoNetworkStore';
import { useUIStore } from '../../../store/uiStore';

vi.mock('../../../utils/ipc', () => ({ invokeIpc: vi.fn(), getErrorMessage: String }));
vi.mock('../SpeleoWorkspace', () => ({ SpeleoWorkspace: () => <div data-testid="workspace-test-body" /> }));

beforeEach(() => {
  useSpeleoNetworkStore.getState().reset();
  useUIStore.setState({ appMode: 'survey', leftWorkspace: 'sections', surveyLeftWorkspace: 'sections' });
});

describe('SpeleoNetworkBusyIndicator', () => {
  it('shows nothing while idle but keeps its live region mounted', () => {
    render(<SpeleoNetworkBusyIndicator />);
    expect(screen.queryByTestId('speleodb-network-busy')).toBeNull();
    const slot = screen.getByTestId('speleodb-network-busy-slot');
    expect(slot).toHaveAttribute('role', 'status');
    expect(slot).toHaveAttribute('aria-live', 'polite');
    expect(slot).toBeEmptyDOMElement();
  });

  it('shows a labelled spinner while a call is in flight and hides it after', () => {
    render(<SpeleoNetworkBusyIndicator />);
    let end!: () => void;
    act(() => {
      end = useSpeleoNetworkStore.getState().begin('read');
    });
    const spinner = screen.getByTestId('speleodb-network-busy');
    expect(spinner).toHaveAttribute('title', SPELEO_NETWORK_BUSY_LABEL);
    expect(screen.getByRole('status')).toHaveTextContent(SPELEO_NETWORK_BUSY_LABEL);
    expect(SPELEO_NETWORK_BUSY_LABEL).toBe('Talking to SpeleoDB...');
    act(() => end());
    expect(screen.queryByTestId('speleodb-network-busy')).toBeNull();
  });

  it('reserves no space: a zero-size slot with the spinner positioned off it', () => {
    render(<SpeleoNetworkBusyIndicator />);
    act(() => {
      useSpeleoNetworkStore.getState().begin('exclusive');
    });
    const slot = screen.getByTestId('speleodb-network-busy-slot');
    expect(slot.className).toMatch(/\bw-0\b/);
    expect(slot.className).toMatch(/\bh-0\b/);
    expect(slot.className).toMatch(/\brelative\b/);
    expect(screen.getByTestId('speleodb-network-busy').className).toMatch(/\babsolute\b/);
  });

  it('draws the spinner filled, never stroked', () => {
    render(<SpeleoNetworkBusyIndicator />);
    act(() => {
      useSpeleoNetworkStore.getState().begin('read');
    });
    const svg = screen.getByTestId('speleodb-network-busy').querySelector('svg')!;
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    for (const shape of svg.querySelectorAll('path')) {
      expect(shape.getAttribute('fill')).toBe('currentColor');
      expect(shape.getAttribute('stroke')).toBeNull();
    }
  });
});

describe('LeftWorkspace busy indicator placement', () => {
  it('sits inside the SpeleoDB tab only', () => {
    render(<LeftWorkspace sections={<div />} />);
    act(() => {
      useSpeleoNetworkStore.getState().begin('read');
    });
    const speleo = screen.getByTestId('workspace-tab-speleodb');
    const sections = screen.getByTestId('workspace-tab-sections');
    expect(within(speleo).getByTestId('speleodb-network-busy')).toBeInTheDocument();
    expect(within(sections).queryByTestId('speleodb-network-busy')).toBeNull();
    expect(screen.getAllByTestId('speleodb-network-busy')).toHaveLength(1);
  });

  it('is present in Plan mode, where SpeleoDB is the only tab', () => {
    useUIStore.setState({ appMode: 'plan', leftWorkspace: 'speleodb' });
    render(<LeftWorkspace sections={<div />} />);
    act(() => {
      useSpeleoNetworkStore.getState().begin('exclusive');
    });
    expect(within(screen.getByTestId('workspace-tab-speleodb')).getByTestId('speleodb-network-busy')).toBeInTheDocument();
  });
});
