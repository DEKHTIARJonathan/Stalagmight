/**
 * Component test (#465) - entrance elevation display + edit in the Project
 * Settings dialog's General tab.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../utils/telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/telemetry')>()),
}));

import '../../i18n';
import { ProjectSettingsDialog as Dialog } from './ProjectSettingsDialog';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';
import { useSpeleoStore } from '../../store/speleoStore';
import { defaultConfig } from '../../types/config';
import type { Project } from '../../types/project';
import type { CommandResult } from '../../types/commands';

let updateProjectSettings: ReturnType<typeof vi.fn>;
let setSurfaceElevation: ReturnType<typeof vi.fn>;
let closeDialog: ReturnType<typeof vi.fn>;

function baseProject(overrides: Partial<Project> = {}): Project {
  return {
    name: 'Test Project',
    location: null,
    validation: defaultConfig.validation,
    surface_elevation: null,
    ...overrides,
  } as unknown as Project;
}

beforeEach(() => {
  updateProjectSettings = vi.fn(async (): Promise<CommandResult> => ({ success: true, error: null }) as CommandResult);
  setSurfaceElevation = vi.fn(async (): Promise<CommandResult> => ({ success: true, error: null }) as CommandResult);
  closeDialog = vi.fn();
  useProjectStore.setState({
    project: baseProject(),
    config: defaultConfig,
    updateProjectSettings,
    setSurfaceElevation,
  });
  useUIStore.setState({ closeDialog, showToast: vi.fn(), geometryMode: 'measured', appMode: 'survey' });
  useSpeleoStore.setState({ link: null, projectLinkKind: 'local' });
});

describe('ProjectSettingsDialog entrance elevation (#465)', () => {
  it('shows the not-recorded state explicitly, never 0.0', async () => {
    render(<Dialog />);
    const input = await screen.findByTestId('project-settings-elevation');
    // jest-dom reports an empty `type="number"` input's value as `null`.
    expect(input).toHaveValue(null);
    expect(input).toHaveAttribute('placeholder', 'Not recorded');
  });

  it('displays a previously recorded elevation', async () => {
    useProjectStore.setState({ project: baseProject({ surface_elevation: 42.5 }) });
    render(<Dialog />);
    const input = await screen.findByTestId('project-settings-elevation');
    expect(input).toHaveValue(42.5);
  });

  it('saves a typed elevation via setSurfaceElevation, in meters', async () => {
    render(<Dialog />);
    const input = await screen.findByTestId('project-settings-elevation');
    // fireEvent sets the value atomically - `userEvent.type` on a
    // `type="number"` input hits a jsdom quirk where intermediate strings
    // like "42." are treated as invalid and reset to "".
    fireEvent.change(input, { target: { value: '42.5' } });
    await userEvent.click(screen.getByTestId('project-settings-save'));

    expect(setSurfaceElevation).toHaveBeenCalledWith(42.5);
    expect(closeDialog).toHaveBeenCalled();
  });

  it('clears a recorded elevation back to null (not 0.0)', async () => {
    useProjectStore.setState({ project: baseProject({ surface_elevation: 42.5 }) });
    render(<Dialog />);
    const input = await screen.findByTestId('project-settings-elevation');
    fireEvent.change(input, { target: { value: '' } });
    await userEvent.click(screen.getByTestId('project-settings-save'));

    expect(setSurfaceElevation).toHaveBeenCalledWith(null);
  });

  it('does not call setSurfaceElevation when the value is unchanged', async () => {
    useProjectStore.setState({ project: baseProject({ surface_elevation: 42.5 }) });
    render(<Dialog />);
    await screen.findByTestId('project-settings-elevation');
    await userEvent.click(screen.getByTestId('project-settings-save'));

    expect(setSurfaceElevation).not.toHaveBeenCalled();
  });

  it('is disabled and Save is blocked when editing is blocked (read-only gate)', async () => {
    useUIStore.setState({ geometryMode: 'closureAdjusted' });
    useProjectStore.setState({ project: baseProject({ surface_elevation: 10 }) });
    render(<Dialog />);
    const input = await screen.findByTestId('project-settings-elevation');
    expect(input).toBeDisabled();
    expect(screen.getByTestId('project-settings-save')).toBeDisabled();
  });
});
