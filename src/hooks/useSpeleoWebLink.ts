import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useUIStore } from '../store/uiStore';
import { useSpeleoStore } from '../store/speleoStore';
import { speleoProjectUrl, type SpeleoWebPage } from '../utils/speleoWebUrl';

/**
 * The "open this project on speleodb.org" affordance: the resolved URL (null when
 * we have no openable one - see {@link speleoProjectUrl}) plus the click handler.
 *
 * The endpoint comes from the SESSION, not the config: changing the configured
 * endpoint only affects future logins (see the comment on `SpeleoSession.endpoint`),
 * so the config value can point at a server this project does not live on.
 */
export function useSpeleoWebLink(page?: SpeleoWebPage): { url: string | null; open: () => void } {
  const { t } = useTranslation();
  const showToast = useUIStore((s) => s.showToast);
  const endpoint = useSpeleoStore((s) => s.session?.endpoint ?? null);
  const projectId = useSpeleoStore((s) => s.remoteProjectId);

  const url = speleoProjectUrl(endpoint, projectId, page);

  const open = useCallback(() => {
    if (!url) return;
    // A user-initiated "open my browser" that silently does nothing is worse than
    // a toast, so the rejection is surfaced rather than logged and dropped.
    void openUrl(url).catch(() => {
      showToast(t('speleodb.web.failed'), 'speleodb-web', 'error');
    });
  }, [url, showToast, t]);

  return { url, open };
}
