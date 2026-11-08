import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SpeleoProjectInfo } from '../SpeleoProjectInfo';
import { resolveSpeleoLock } from '../SpeleoLockBadge';
import type { SpeleoProjectSummary } from '../../../types/ipc.generated';

const summary: SpeleoProjectSummary = {
  id: 'project', name: 'Cave', permission: 'ADMIN', lock_holder: null,
  type_tag: 'stalx', latest_commit_sha: null,
};

function show(holder: string | null | undefined, permission = summary.permission) {
  const lock = resolveSpeleoLock({ is_remote: true, speleodb_project_id: summary.id },
    holder === undefined ? {} : { project: holder }, 'me@example.com');
  render(<SpeleoProjectInfo summary={{ ...summary, permission }} lock={lock} testIdPrefix="project" />);
}

describe('SpeleoDB listing information', () => {
  it('shows the SpeleoDB identity, full permission and unlocked state', () => {
    show(null);
    expect(screen.getByText('SpeleoDB')).toBeVisible();
    expect(screen.getByTestId('project-permission')).toHaveTextContent('Permission: Admin');
    expect(screen.getByTestId('project-lock')).toHaveTextContent('Not locked');
  });
  it('identifies our own lock using the account email', () => {
    show('ME@example.com');
    expect(screen.getByTestId('project-lock')).toHaveTextContent('LOCKED by you (ME@example.com)');
  });
  it('names another lock owner', () => {
    show('other@example.com');
    expect(screen.getByTestId('project-lock')).toHaveTextContent('LOCKED by other@example.com');
  });
  it('does not invent permission or unlocked state before the server answers', () => {
    show(undefined, null);
    expect(screen.getByTestId('project-permission')).toHaveTextContent('Permission: Unknown');
    expect(screen.getByTestId('project-lock')).toHaveTextContent('Lock status unknown');
  });
});
