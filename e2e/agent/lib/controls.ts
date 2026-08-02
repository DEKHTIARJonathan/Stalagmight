import type { Browser } from 'webdriverio';
import { randomUUID } from 'node:crypto';
import { evalInApp } from './page';
import { cssStringLiteral, testIdSelector } from '../../../scripts/lib/test-id-selector.mjs';

export interface ElementTarget {
  testid?: string;
  selector?: string;
}

export interface DragRequest {
  fromTestid?: string;
  fromSelector?: string;
  fromX?: number;
  fromY?: number;
  toTestid?: string;
  toSelector?: string;
  toX?: number;
  toY?: number;
  button?: 'left' | 'right' | 'middle';
  durationMs?: number;
}

export interface ScrollRequest extends ElementTarget {
  deltaX?: number;
  deltaY?: number;
  block?: ScrollLogicalPosition;
  inline?: ScrollLogicalPosition;
}

export interface SelectOptionRequest extends ElementTarget {
  value: string;
}

export interface ElementState {
  selector: string;
  count: number;
  unique: boolean;
  elements: Array<{
    index: number;
    tag: string;
    testid: string | null;
    id: string | null;
    role: string | null;
    text: string;
    value: string | null;
    displayed: boolean;
    disabled: boolean;
    checked: boolean | null;
    selected: boolean | null;
    ariaChecked: string | null;
    ariaExpanded: string | null;
    ariaPressed: string | null;
    ariaSelected: string | null;
  }>;
  truncated: boolean;
}

export interface MapClickResult {
  x: number;
  y: number;
  interaction: 'maplibre' | 'placement';
  interactionSequence: number;
}

export function targetSelector(target: ElementTarget): string | undefined {
  return target.testid !== undefined ? testIdSelector(target.testid) : target.selector;
}

function requireSelector(target: ElementTarget, action: string): string {
  const selector = targetSelector(target);
  if (!selector) throw new Error(`${action} needs testid or selector`);
  return selector;
}

export async function hoverElement(browser: Browser, target: ElementTarget): Promise<string> {
  const selector = requireSelector(target, 'hover');
  const element = browser.$(selector);
  await element.waitForDisplayed({ timeout: 5000 });
  await element.moveTo();
  return selector;
}

export async function dragPointer(browser: Browser, request: DragRequest): Promise<{
  fromSelector?: string;
  toSelector?: string;
  fromPoint?: { x: number; y: number };
  toPoint?: { x: number; y: number };
}> {
  const fromSelector = targetSelector({ testid: request.fromTestid, selector: request.fromSelector });
  const toSelector = targetSelector({ testid: request.toTestid, selector: request.toSelector });
  const hasFromPoint = typeof request.fromX === 'number' && typeof request.fromY === 'number';
  const hasToPoint = typeof request.toX === 'number' && typeof request.toY === 'number';
  if (!fromSelector && !hasFromPoint) throw new Error('drag needs fromTestid/fromSelector or fromX+fromY');
  if (!toSelector && !hasToPoint) throw new Error('drag needs toTestid/toSelector or toX+toY');

  const pointer = browser.action('pointer', { parameters: { pointerType: 'mouse' } });
  if (fromSelector) {
    const source = browser.$(fromSelector);
    await source.waitForDisplayed({ timeout: 5000 });
    pointer.move({ origin: source, x: 0, y: 0 });
  } else {
    pointer.move({ origin: 'viewport', x: Math.round(request.fromX!), y: Math.round(request.fromY!) });
  }
  pointer.down({ button: request.button ?? 'left' }).pause(50);
  if (toSelector) {
    const target = browser.$(toSelector);
    await target.waitForDisplayed({ timeout: 5000 });
    pointer.move({ origin: target, x: 0, y: 0, duration: request.durationMs ?? 500 });
  } else {
    pointer.move({
      origin: 'viewport',
      x: Math.round(request.toX!),
      y: Math.round(request.toY!),
      duration: request.durationMs ?? 500,
    });
  }
  await pointer.up({ button: request.button ?? 'left' }).perform();

  return {
    fromSelector,
    toSelector,
    fromPoint: hasFromPoint ? { x: Math.round(request.fromX!), y: Math.round(request.fromY!) } : undefined,
    toPoint: hasToPoint ? { x: Math.round(request.toX!), y: Math.round(request.toY!) } : undefined,
  };
}

export async function scrollTarget(browser: Browser, request: ScrollRequest): Promise<string | undefined> {
  const selector = targetSelector(request);
  const hasDelta = request.deltaX !== undefined || request.deltaY !== undefined;
  if (!hasDelta) {
    if (!selector) throw new Error('scroll without deltaX/deltaY needs testid or selector');
    const element = browser.$(selector);
    await element.waitForExist({ timeout: 5000 });
    await element.scrollIntoView({
      behavior: 'instant',
      block: request.block ?? 'center',
      inline: request.inline ?? 'nearest',
    });
    return selector;
  }

  await evalInApp(
    browser,
    `
      const selector = args[0];
      const target = selector ? document.querySelector(selector) : window;
      if (!target) throw new Error('scroll target not found: ' + selector);
      target.scrollBy({ left: args[1], top: args[2], behavior: 'instant' });
      return true;
    `,
    [selector ?? null, request.deltaX ?? 0, request.deltaY ?? 0],
  );
  return selector;
}

export async function selectOption(browser: Browser, request: SelectOptionRequest): Promise<{
  selector: string;
  optionSelector?: string;
  native: boolean;
}> {
  const selector = requireSelector(request, 'select_option');
  const trigger = browser.$(selector);
  await trigger.waitForDisplayed({ timeout: 5000 });
  if ((await trigger.getTagName()).toLowerCase() === 'select') {
    await trigger.selectByAttribute('value', request.value);
    return { selector, native: true };
  }

  const testId = request.testid ?? (await trigger.getAttribute('data-testid'));
  if (!testId) {
    throw new Error('custom select_option needs a testid so its portaled option can be targeted');
  }
  await trigger.waitForClickable({ timeout: 5000 });
  await trigger.click();
  const optionSelector = testIdSelector(`${testId}-option-${encodeURIComponent(request.value)}`);
  const option = browser.$(optionSelector);
  await option.waitForClickable({ timeout: 5000 });
  await option.click();
  return { selector, optionSelector, native: false };
}

export async function queryElementState(browser: Browser, target: ElementTarget): Promise<ElementState> {
  const selector = requireSelector(target, 'element_state');
  return evalInApp<ElementState>(
    browser,
    `
      const selector = args[0];
      const nodes = Array.from(document.querySelectorAll(selector));
      const elements = nodes.slice(0, 50).map((node, index) => {
        const el = node;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const hasValue = 'value' in el;
        const hasChecked = 'checked' in el;
        const hasSelected = 'selected' in el;
        return {
          index,
          tag: el.tagName.toLowerCase(),
          testid: el.getAttribute('data-testid'),
          id: el.id || null,
          role: el.getAttribute('role'),
          text: (el.textContent || '').trim().slice(0, 500),
          value: hasValue ? String(el.value) : null,
          displayed: style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0,
          disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
          checked: hasChecked ? Boolean(el.checked) : null,
          selected: hasSelected ? Boolean(el.selected) : null,
          ariaChecked: el.getAttribute('aria-checked'),
          ariaExpanded: el.getAttribute('aria-expanded'),
          ariaPressed: el.getAttribute('aria-pressed'),
          ariaSelected: el.getAttribute('aria-selected'),
        };
      });
      return { selector, count: nodes.length, unique: nodes.length === 1, elements, truncated: nodes.length > elements.length };
    `,
    [selector],
  );
}

export async function answerFileDialog(
  browser: Browser,
  triggerTestId: string,
  kind: 'open' | 'save',
  value: string | string[] | null,
): Promise<{ answerId: string; selector: string; consumed: true }> {
  const answerId = randomUUID();
  const selector = testIdSelector(triggerTestId);
  const queued = await evalInApp<boolean>(
    browser,
    `
      const testApi = window.__E2E_TEST__;
      const hooks = testApi && testApi.fileDialogAnswers;
      if (!hooks || !Array.isArray(hooks[args[0]])) return false;
      if (hooks[args[0]].length > 0) throw new Error('a file dialog answer is already pending');
      const trigger = document.querySelector(args[4]);
      if (!trigger) throw new Error('file dialog trigger not found: ' + args[3]);
      const entry = { id: args[1], value: args[2], triggerTestId: args[3], armed: false };
      hooks[args[0]].push(entry);
      trigger.addEventListener('click', () => { entry.armed = true; }, { capture: true, once: true });
      return true;
    `,
    [kind, answerId, value, triggerTestId, selector],
  );
  if (!queued) throw new Error('file dialog hooks are unavailable; start an E2E build');

  try {
    const trigger = browser.$(selector);
    await trigger.waitForDisplayed({ timeout: 5000 });
    await trigger.waitForClickable({ timeout: 5000 });
    await trigger.click();
    await browser.waitUntil(
      () =>
        evalInApp<boolean>(
          browser,
          `return window.__E2E_TEST__?.fileDialogConsumptions?.[args[0]] === args[1];`,
          [answerId, kind],
        ),
      {
        timeout: 5000,
        timeoutMsg: `file dialog answer ${answerId} was not consumed by ${triggerTestId}`,
      },
    );
    return { answerId, selector, consumed: true };
  } finally {
    await evalInApp(
      browser,
      `
        const testApi = window.__E2E_TEST__;
        const queue = testApi?.fileDialogAnswers?.[args[0]];
        const index = queue?.findIndex((entry) => entry.id === args[1]) ?? -1;
        if (index >= 0) queue.splice(index, 1);
        if (testApi?.fileDialogConsumptions) delete testApi.fileDialogConsumptions[args[1]];
      `,
      [kind, answerId],
    ).catch(() => undefined);
  }
}

export async function mapClick(
  browser: Browser,
  lngLat: [number, number],
  button: 'left' | 'right' = 'left',
): Promise<MapClickResult> {
  const outcome = await evalInApp<MapClickResult | { error: string } | null>(
    browser,
    `
      const map = window.__stalagmight_map__;
      const readInteraction = window.__stalagmight_map_interaction__;
      if (!map || !map.project) return null;
      if (typeof readInteraction !== 'function') return { error: 'map interaction hooks are unavailable' };
      const interactionSequenceBefore = readInteraction();
      const projected = map.project(args[0]);
      const canvasRoot = document.querySelector('[data-testid="map-canvas"]');
      const surface = map.getCanvas && map.getCanvas();
      if (!canvasRoot || !surface) return null;
      const rect = surface.getBoundingClientRect();
      if (projected.x < 0 || projected.y < 0 || projected.x >= rect.width || projected.y >= rect.height) {
        return {
          error: 'map point is outside the visible viewport: [' + args[0][0] + ', ' + args[0][1] + '] projects to [' +
            Math.round(projected.x) + ', ' + Math.round(projected.y) + '] for a ' +
            Math.round(rect.width) + 'x' + Math.round(rect.height) + ' map',
        };
      }
      const point = { x: Math.round(rect.left + projected.x), y: Math.round(rect.top + projected.y) };
      const eventName = args[1] === 'right' ? 'contextmenu' : 'click';

      // Placement is owned by MapCanvas's React pointer handlers, not MapLibre's
      // click event. Drive the same DOM path a user does so the placement callback
      // creates or moves the section instead of reporting a false-positive click.
      if (canvasRoot.dataset.placementMode === 'true') {
        if (args[1] === 'right') {
          const event = new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            button: 2,
            buttons: 2,
            clientX: point.x,
            clientY: point.y,
          });
          surface.dispatchEvent(event);
          if (!event.defaultPrevented) return { error: 'placement context-menu event was not handled' };
        } else {
          const PointerEventCtor = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
          const down = new PointerEventCtor('pointerdown', {
            bubbles: true,
            cancelable: true,
            button: 0,
            buttons: 1,
            clientX: point.x,
            clientY: point.y,
            pointerId: 1,
            pointerType: 'mouse',
            isPrimary: true,
          });
          surface.dispatchEvent(down);
          surface.dispatchEvent(new PointerEventCtor('pointerup', {
            bubbles: true,
            cancelable: true,
            button: 0,
            buttons: 0,
            clientX: point.x,
            clientY: point.y,
            pointerId: 1,
            pointerType: 'mouse',
            isPrimary: true,
          }));
          if (!down.defaultPrevented) return { error: 'placement pointer event was not handled' };
        }
        const interactionSequence = readInteraction();
        if (interactionSequence <= interactionSequenceBefore) {
          return { error: 'map placement handler did not process the click' };
        }
        return { ...point, interaction: 'placement', interactionSequence };
      }

      map.fire(eventName, {
        point: { x: projected.x, y: projected.y },
        lngLat: map.unproject([projected.x, projected.y]),
        originalEvent: new MouseEvent(eventName, {
          bubbles: true,
          cancelable: true,
          button: args[1] === 'right' ? 2 : 0,
          clientX: point.x,
          clientY: point.y,
        }),
      });
      const interactionSequence = readInteraction();
      if (interactionSequence <= interactionSequenceBefore) {
        return { error: 'map interaction handler did not process the click' };
      }
      return { ...point, interaction: 'maplibre', interactionSequence };
    `,
    [lngLat, button],
  );
  if (!outcome) throw new Error('map not available');
  if ('error' in outcome) throw new Error(outcome.error);
  return outcome;
}

export { cssStringLiteral, testIdSelector };
