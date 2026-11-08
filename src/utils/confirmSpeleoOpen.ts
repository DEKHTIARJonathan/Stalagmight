import { confirm } from '@tauri-apps/plugin-dialog';
import i18n from '../i18n';
import { invokeIpc } from './ipc';
import type { SpeleoProjectSummary } from '../types/ipc.generated';

/** Warn before opening a project with restricted access. Cancel leaves it unopened. */
export async function confirmSpeleoOpen(summary: SpeleoProjectSummary): Promise<boolean> {
  const warnings = [
    summary.permission === 'READ_ONLY' ? i18n.t('speleodb.browser.readOnlyWarning') : null,
    summary.lock_holder ? i18n.t('speleodb.browser.lockedWarning', { email: summary.lock_holder }) : null,
  ].filter(Boolean);
  if (!warnings.length) return true;
  return confirm(warnings.join('\n\n'), {
    title: summary.name,
    kind: 'warning',
    okLabel: i18n.t('speleodb.browser.open'),
    cancelLabel: i18n.t('common.actions.cancel'),
  });
}

/** Probe disk metadata even before the recents/session caches have loaded. */
export async function confirmSpeleoFileOpen(path: string): Promise<boolean> {
  const summary = await invokeIpc<SpeleoProjectSummary | null>('speleodb_project_access_at', { path });
  return !summary || confirmSpeleoOpen(summary);
}
