/**
 * The rows of the SpeleoDB menu for the open remote project: the hand-off verbs
 * (lock / unlock / reconnect, push, refresh, the opt-in force-edit), then the two
 * destinations - the project on speleodb.org and its SpeleoDB settings dialog.
 * Verbs first, destinations last, separated: acting on the project is the common
 * errand, and a destination that sits among the verbs gets pressed by mistake.
 *
 * Split out of `useProjectMenuItems` so the same `AppMenuItem[]` can back a SECOND
 * surface - the right-click menu on the toolbar's SpeleoDB status button
 * (`SpeleoStatusMenu`). Both render these rows with the same ids, so one selector
 * (or one test helper) reaches either surface.
 *
 * Returns `[]` for a local project; the caller decides whether a wrapper row is
 * worth rendering at all.
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '../../store/uiStore';
import { useSpeleoStore } from '../../store/speleoStore';
import { useSpeleoActions } from '../../hooks/useSpeleoActions';
import { useSpeleoWebLink } from '../../hooks/useSpeleoWebLink';
import {
  SpeleoBadgedIcon,
  PushGlyph,
  RefreshGlyph,
  EditNoLockGlyph,
  ExternalLinkGlyph,
} from '../common/SpeleoBadgedIcon';
import type { AppMenuItem } from '../common/AppMenu';
import { SlidersIcon, PencilIcon, LockIcon } from '../common/icons';

export function useSpeleoMenuItems(): AppMenuItem[] {
  const { t } = useTranslation();
  const openDialog = useUIStore((s) => s.openDialog);
  const link = useSpeleoStore((s) => s.link);
  const { busy, startEditing, update, done } = useSpeleoActions();
  // No page argument: the plain project page is the one a "take me to this project"
  // row should land on.
  const web = useSpeleoWebLink();

  return useMemo<AppMenuItem[]>(() => {
    if (!link) return [];
    const sz = 18;

    return [
      link.editState === 'editing' && link.forceEditing
        ? {
            // #213: a force-editor holds no lock, so the top action is
            // Reconnect (acquire + reconcile), NOT Unlock. Done/push are
            // backend-guarded for this state, so we never offer them here.
            id: 'speleodb-menu-reconnect',
            label: t('speleodb.forceEdit.reconnect'),
            icon: <SpeleoBadgedIcon badge={<LockIcon size={9} />} badgeColor="text-yellow-400" size={sz} />,
            disabled: busy,
            onClick: () => {
              void startEditing();
            },
          }
        : link.editState === 'editing'
        ? {
            id: 'speleodb-menu-unlock',
            label: t('speleodb.menu.unlock'),
            icon: <SpeleoBadgedIcon badge={<LockIcon size={9} />} badgeColor="text-green-400" size={sz} />,
            disabled: busy,
            onClick: () => {
              // Release; the push&release dialog when there are local edits.
              if (link.hasUnpushedEdits) openDialog('speleodb-done');
              else void done(null);
            },
          }
        : {
            id: 'speleodb-menu-lock',
            label: t('speleodb.menu.lock'),
            icon: <SpeleoBadgedIcon badge={<PencilIcon size={9} />} badgeColor="text-yellow-400" size={sz} />,
            disabled: busy,
            onClick: () => {
              void startEditing();
            },
          },
      {
        id: 'speleodb-menu-push',
        label: t('speleodb.menu.push'),
        icon: <SpeleoBadgedIcon badge={<PushGlyph size={9} />} badgeColor="text-green-400" size={sz} />,
        // Push-without-unlock only makes sense while editing with edits.
        disabled: busy || link.editState !== 'editing' || !link.hasUnpushedEdits,
        // Collect a commit message via the done dialog in push mode (like
        // push & release, but the lock is retained - fix 8).
        onClick: () => openDialog('speleodb-done', { mode: 'push' }),
      },
      {
        id: 'speleodb-menu-refresh',
        label: t('speleodb.menu.refresh'),
        icon: <SpeleoBadgedIcon badge={<RefreshGlyph size={11} />} badgeColor="text-blue-400" size={sz} />,
        disabled: busy,
        onClick: () => {
          void update();
        },
      },
      // #213: optimistic force-edit - edit WITHOUT the lock, behind the
      // `allow_force_edit` opt-in (hidden otherwise) and a big-red confirm.
      // Only offered while read-only; a force-editor uses Reconnect above.
      ...(link.forceEditAllowed && link.editState !== 'editing'
        ? [
            {
              id: 'speleodb-menu-edit-without-lock',
              label: t('speleodb.menu.editWithoutLock'),
              icon: (
                <SpeleoBadgedIcon badge={<EditNoLockGlyph size={11} />} badgeColor="text-red-500" size={sz} />
              ),
              disabled: busy,
              onClick: () => openDialog('speleodb-force-edit'),
            },
          ]
        : []),
      { id: 'speleodb-menu-sep-1', label: '', separator: true },
      {
        id: 'speleodb-menu-open-web',
        label: t('speleodb.web.openProject'),
        // The SpeleoDB mark with the open-on-the-web glyph badged onto it, like
        // every other row here. A bare external-link icon read as a generic link
        // rather than "this project, over there", and it was the only row in the
        // submenu not carrying the mark.
        icon: (
          <SpeleoBadgedIcon
            badge={<ExternalLinkGlyph size={9} />}
            badgeColor="text-blue-400"
            size={sz}
          />
        ),
        // Signed out (or no remote id yet) there is no URL to resolve, and a row
        // that silently does nothing is worse than a greyed one.
        disabled: web.url === null,
        onClick: web.open,
      },
      {
        id: 'speleodb-menu-project-settings',
        label: t('speleodb.projectDialog.open'),
        icon: (
          <SpeleoBadgedIcon badge={<SlidersIcon size={9} />} badgeColor="text-blue-400" size={sz} />
        ),
        onClick: () => openDialog('speleodb-project'),
      },
    ];
  }, [t, openDialog, link, busy, startEditing, update, done, web.url, web.open]);
}
