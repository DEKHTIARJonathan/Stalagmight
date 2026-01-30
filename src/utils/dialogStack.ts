import { useSyncExternalStore } from 'react';

/**
 * Module-level stack of open dialog container elements.
 * The last element is the topmost (interactive) dialog.
 */
const stack: HTMLElement[] = [];

/**
 * Subscribers for the React hook.
 */
const listeners = new Set<() => void>();

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Set `inert` on all siblings of `#dialog-root` (i.e., the app root and any
 * other siblings). This makes the entire app non-interactive when a dialog is open.
 */
function setAppInert(inert: boolean): void {
  const dialogRoot = document.getElementById('dialog-root');
  if (!dialogRoot?.parentElement) {
    if (import.meta.env.DEV) {
      console.warn(
        '[dialogStack] #dialog-root element not found in DOM. ' +
        'Add <div id="dialog-root"></div> to index.html after #root.',
      );
    }
    return;
  }

  const siblings = dialogRoot.parentElement.children;
  for (const sibling of siblings) {
    if (sibling === dialogRoot) continue;
    if (inert) {
      sibling.setAttribute('inert', '');
    } else {
      sibling.removeAttribute('inert');
    }
  }
}

/**
 * Push a dialog container onto the stack.
 *
 * - Sets `inert` on all siblings of `#dialog-root` (app root)
 * - Sets `inert` on all previously-stacked dialog containers
 *   so only the topmost dialog is interactive
 */
export function pushDialog(element: HTMLElement): void {
  // De-duplicate: if already in stack, move to top
  const existing = stack.indexOf(element);
  if (existing !== -1) {
    stack.splice(existing, 1);
  }

  // Set inert on all previously-stacked dialog containers
  for (const prev of stack) {
    prev.setAttribute('inert', '');
  }

  stack.push(element);

  // Ensure the new topmost dialog is interactive
  element.removeAttribute('inert');

  // Always set app siblings inert when any dialog is open
  setAppInert(true);

  emitChange();
}

/**
 * Remove a dialog container from the stack.
 *
 * - Removes `inert` from the new topmost dialog (if any)
 * - Removes `inert` from app siblings only if stack is now empty
 */
export function popDialog(element: HTMLElement): void {
  const index = stack.indexOf(element);
  if (index === -1) return;

  stack.splice(index, 1);

  // Clear inert from the popped element to avoid stale attributes
  element.removeAttribute('inert');

  if (stack.length === 0) {
    // No dialogs left — restore app interactivity
    setAppInert(false);
  } else {
    // Restore interactivity to the new topmost dialog
    const topmost = stack[stack.length - 1]!;
    topmost.removeAttribute('inert');
  }

  emitChange();
}

/**
 * Check if the given element is the topmost dialog in the stack.
 */
export function isTopmost(element: HTMLElement): boolean {
  return stack.length > 0 && stack[stack.length - 1] === element;
}

/**
 * Get a snapshot of the current stack size.
 */
function getSnapshot(): number {
  return stack.length;
}

/**
 * Subscribe to stack changes.
 */
function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

/**
 * React hook that returns the current dialog stack size.
 * Re-renders the component when the stack changes.
 */
export function useDialogStack(): { stackSize: number } {
  const stackSize = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { stackSize };
}
