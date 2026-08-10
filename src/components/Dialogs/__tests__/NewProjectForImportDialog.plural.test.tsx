/**
 * #447 item 1: the create-for-import summary used to interpolate a raw count
 * into a hardcoded plural ("1 sections - 12 shots"). Renders through the real
 * i18next instance (unlike the sibling suite's stubbed `t`) so the `_one`/
 * `_other` plural forms in en.json are actually exercised.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import '../../../i18n';

const dialogData: {
  dmpFile?: { sections: Array<{ shots: Array<{ shot_type: string }> }> };
  tmlFile?: unknown;
  filePath?: string;
  importType?: string;
  defaultName?: string;
} = {};

const closeDialog = vi.fn();
const openDialog = vi.fn();
const setImportContext = vi.fn();

vi.mock('../../../store/uiStore', () => ({
  useUIStore: () => ({ closeDialog, dialogData, openDialog, setImportContext }),
}));

const createProject = vi.fn();
vi.mock('../../../store/projectStore', () => ({
  useProjectStore: () => ({ createProject }),
}));

vi.mock('../DialogWrapper', () => ({
  DialogWrapper: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div>
      <div data-testid="dialog-title">{title}</div>
      {children}
    </div>
  ),
}));

vi.mock('../../common/Button', () => ({
  Button: ({ children, ...rest }: React.ComponentProps<'button'>) => (
    <button {...rest}>{children}</button>
  ),
}));

import NewProjectForImportDialog from '../NewProjectForImportDialog';

function dmpFileWithSections(count: number): { sections: Array<{ shots: Array<{ shot_type: string }> }> } {
  return {
    sections: Array.from({ length: count }, () => ({ shots: [{ shot_type: 'Standard' }] })),
  };
}

describe('NewProjectForImportDialog summary plurals (#447)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dialogData.tmlFile = undefined;
    dialogData.filePath = '/cave/exports/survey.dmp';
    dialogData.importType = 'dmp';
    dialogData.defaultName = 'Survey';
  });

  it('uses the singular form for exactly one section and one shot', () => {
    dialogData.dmpFile = dmpFileWithSections(1);

    render(<NewProjectForImportDialog />);

    expect(screen.getByText('1 section - 1 shot')).toBeInTheDocument();
  });

  it('uses the plural form for multiple sections and shots', () => {
    dialogData.dmpFile = dmpFileWithSections(3);

    render(<NewProjectForImportDialog />);

    expect(screen.getByText('3 sections - 3 shots')).toBeInTheDocument();
  });

  it('uses the plural form for zero sections/shots', () => {
    dialogData.dmpFile = dmpFileWithSections(0);

    render(<NewProjectForImportDialog />);

    expect(screen.getByText('0 sections - 0 shots')).toBeInTheDocument();
  });
});
