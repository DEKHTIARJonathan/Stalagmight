/**
 * An in-app yes/no question for the exit paths that used the native
 * `@tauri-apps/plugin-dialog` `confirm`: the window-close tier for an import or a
 * dive plan in progress, the account-change guard, the unsent SpeleoDB input
 * question (`utils/workspaceDrafts`) and the unsaved-changes question before an
 * open from SpeleoDB. No guard or SpeleoDB flow uses a native dialog.
 *
 * Same overlay shape as the SpeleoDB exit prompt (`utils/speleoExit`): its own
 * store, mounted by App above whatever dialog is open, awaited by the caller. A
 * second question while one is open answers the first with "no".
 */
import { create } from 'zustand';

export interface ExitConfirmOptions {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
}

export interface ExitConfirmRequest extends ExitConfirmOptions {
  id: number;
  answer: (yes: boolean) => void;
}

export const useExitConfirm = create<{ request: ExitConfirmRequest | null }>(() => ({ request: null }));

let nextId = 0;

/** Ask, and resolve with the answer. Dismissing (Escape, X, backdrop) is "no". */
export function askExitConfirm(options: ExitConfirmOptions): Promise<boolean> {
  useExitConfirm.getState().request?.answer(false);
  return new Promise<boolean>((resolve) => {
    const id = ++nextId;
    let answered = false;
    const answer = (yes: boolean) => {
      if (answered) return;
      answered = true;
      if (useExitConfirm.getState().request?.id === id) useExitConfirm.setState({ request: null });
      resolve(yes);
    };
    useExitConfirm.setState({ request: { ...options, id, answer } });
  });
}
