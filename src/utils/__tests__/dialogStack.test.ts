import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { pushDialog, popDialog, isTopmost } from '../dialogStack';

/**
 * Create a mock HTMLElement with the attributes API needed by dialogStack.
 */
function createMockElement(id: string): HTMLElement {
  const attrs = new Map<string, string>();
  return {
    id,
    setAttribute: vi.fn((name: string, value: string) => { attrs.set(name, value); }),
    removeAttribute: vi.fn((name: string) => { attrs.delete(name); }),
    hasAttribute: (name: string) => attrs.has(name),
    getAttribute: (name: string) => attrs.get(name) ?? null,
  } as unknown as HTMLElement;
}

/**
 * Reset the module-level stack between tests by popping all elements.
 * We track pushed elements and pop them in reverse order.
 */
let trackedElements: HTMLElement[] = [];

function pushAndTrack(el: HTMLElement): void {
  pushDialog(el);
  trackedElements.push(el);
}

function resetStack(): void {
  // Pop all tracked elements in reverse
  for (let i = trackedElements.length - 1; i >= 0; i--) {
    popDialog(trackedElements[i]!);
  }
  trackedElements = [];
}

// Mock document.getElementById to return a dialog-root with siblings
const mockDialogRoot = createMockElement('dialog-root');
const mockAppRoot = createMockElement('root');

const mockParent = {
  children: [mockAppRoot, mockDialogRoot],
};
Object.defineProperty(mockDialogRoot, 'parentElement', { value: mockParent });

vi.stubGlobal('document', {
  getElementById: (id: string) => {
    if (id === 'dialog-root') return mockDialogRoot;
    if (id === 'root') return mockAppRoot;
    return null;
  },
});

// Also stub import.meta.env for the dev warning
vi.stubGlobal('import', { meta: { env: { DEV: true } } });

describe('dialogStack', () => {
  beforeEach(() => {
    resetStack();
    vi.clearAllMocks();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  describe('pushDialog', () => {
    it('makes the pushed element topmost', () => {
      const el = createMockElement('dialog-a');
      pushAndTrack(el);
      expect(isTopmost(el)).toBe(true);
    });

    it('sets inert on app root siblings when pushing', () => {
      const el = createMockElement('dialog-a');
      pushAndTrack(el);
      expect(mockAppRoot.setAttribute).toHaveBeenCalledWith('inert', '');
    });

    it('sets inert on previously stacked dialogs', () => {
      const a = createMockElement('dialog-a');
      const b = createMockElement('dialog-b');
      pushAndTrack(a);
      pushAndTrack(b);

      expect(a.setAttribute).toHaveBeenCalledWith('inert', '');
      expect(isTopmost(b)).toBe(true);
      expect(isTopmost(a)).toBe(false);
    });

    it('ensures pushed element is not inert', () => {
      const el = createMockElement('dialog-a');
      pushAndTrack(el);
      expect(el.removeAttribute).toHaveBeenCalledWith('inert');
    });

    it('de-duplicates: moves existing element to top', () => {
      const a = createMockElement('dialog-a');
      const b = createMockElement('dialog-b');
      pushAndTrack(a);
      pushAndTrack(b);

      // Push A again - should move to top
      pushDialog(a);
      trackedElements.push(a); // track for cleanup

      expect(isTopmost(a)).toBe(true);
      expect(isTopmost(b)).toBe(false);
    });
  });

  describe('popDialog', () => {
    it('removes element from stack', () => {
      const el = createMockElement('dialog-a');
      pushAndTrack(el);
      popDialog(el);
      trackedElements = [];

      expect(isTopmost(el)).toBe(false);
    });

    it('clears inert from popped element', () => {
      const el = createMockElement('dialog-a');
      pushAndTrack(el);
      popDialog(el);
      trackedElements = [];

      expect(el.removeAttribute).toHaveBeenCalledWith('inert');
    });

    it('restores interactivity to new topmost dialog', () => {
      const a = createMockElement('dialog-a');
      const b = createMockElement('dialog-b');
      pushAndTrack(a);
      pushAndTrack(b);

      popDialog(b);
      trackedElements.pop();

      expect(isTopmost(a)).toBe(true);
      // a should have inert removed when it becomes topmost again
      expect(a.removeAttribute).toHaveBeenCalledWith('inert');
    });

    it('removes app inert when stack is empty', () => {
      const el = createMockElement('dialog-a');
      pushAndTrack(el);
      vi.clearAllMocks();

      popDialog(el);
      trackedElements = [];

      expect(mockAppRoot.removeAttribute).toHaveBeenCalledWith('inert');
    });

    it('does nothing for unknown element', () => {
      const el = createMockElement('unknown');
      vi.clearAllMocks();
      popDialog(el);
      // Should not throw or modify anything
      expect(mockAppRoot.removeAttribute).not.toHaveBeenCalled();
    });

    it('handles non-LIFO removal correctly', () => {
      const a = createMockElement('dialog-a');
      const b = createMockElement('dialog-b');
      const c = createMockElement('dialog-c');
      pushAndTrack(a);
      pushAndTrack(b);
      pushAndTrack(c);

      // Remove middle element (non-LIFO)
      popDialog(b);
      trackedElements = trackedElements.filter(e => e !== b);

      expect(isTopmost(c)).toBe(true);
      expect(isTopmost(a)).toBe(false);
    });
  });

  describe('isTopmost', () => {
    it('returns false for empty stack', () => {
      const el = createMockElement('dialog-a');
      expect(isTopmost(el)).toBe(false);
    });

    it('returns true only for the last element', () => {
      const a = createMockElement('dialog-a');
      const b = createMockElement('dialog-b');
      pushAndTrack(a);
      pushAndTrack(b);

      expect(isTopmost(a)).toBe(false);
      expect(isTopmost(b)).toBe(true);
    });
  });
});
