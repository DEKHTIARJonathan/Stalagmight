// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createElement, useEffect, useState, type ChangeEvent } from 'react';
import { render } from '@testing-library/react';
import type { Browser } from 'webdriverio';

import { evalInApp } from './page';
import { REACT_SAFE_SET_VALUE_SCRIPT, SYNTHETIC_KEY_SCRIPT } from './reactInput';

/**
 * Runs the runner synchronously against jsdom, exactly like page.test.ts's
 * mock - the real production script string executes in-process here, so
 * this exercises the actual bytes shipped over WebDriver, not a copy.
 */
function executingBrowser(): Browser {
  return {
    executeAsync: (runner: (args: unknown[], done: (result: unknown) => void) => void, args: unknown[]) =>
      new Promise((resolve) => runner(args, resolve)),
  } as unknown as Browser;
}

function mountControlledInput(testid: string, extraProps: Record<string, unknown> = {}) {
  let lastValue = '';
  const seenValues: string[] = [];

  function Fixture() {
    const [value, setValue] = useState('');
    lastValue = value;
    return createElement('input', {
      'data-testid': testid,
      value,
      onChange: (e: ChangeEvent<HTMLInputElement>) => {
        seenValues.push(e.target.value);
        setValue(e.target.value);
      },
      ...extraProps,
    });
  }

  const { unmount } = render(createElement(Fixture));

  return {
    getValue: () => lastValue,
    getChangeCount: () => seenValues.length,
    getSeenValues: () => seenValues,
    unmount,
  };
}

/**
 * A controlled input that accepts every keystroke in onChange (so the
 * SYNCHRONOUS write looks fully accepted - React's own synchronous
 * controlled-input restore has nothing to fight) but clamps to maxLength in
 * a `useEffect`, which React schedules as a passive effect rather than
 * flushing inline with the triggering DOM event. This is the shape a
 * same-tick verified read cannot see and only the settle tick can.
 */
function mountEffectClampingInput(testid: string, maxLength: number) {
  let lastValue = '';

  function Fixture() {
    const [value, setValue] = useState('');
    lastValue = value;
    useEffect(() => {
      if (value.length > maxLength) setValue(value.slice(0, maxLength));
    }, [value]);
    return createElement('input', {
      'data-testid': testid,
      value,
      onChange: (e: ChangeEvent<HTMLInputElement>) => setValue(e.target.value),
    });
  }

  const { unmount } = render(createElement(Fixture));
  return { getValue: () => lastValue, unmount };
}

/** Naive assignment - the pre-#531 behavior that never reaches React state. */
function naiveSetValue(selector: string, text: string) {
  const el = document.querySelector(selector) as HTMLInputElement;
  el.value = text;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('REACT_SAFE_SET_VALUE_SCRIPT', () => {
  it('delivers typed text through onChange on a controlled input', async () => {
    const fixture = mountControlledInput('gps-lat');
    const browser = executingBrowser();

    const result = await evalInApp<{ ok: boolean; verified: boolean }>(browser, REACT_SAFE_SET_VALUE_SCRIPT, [
      '[data-testid="gps-lat"]',
      '12.5',
      false,
    ]);

    expect(result).toEqual({ ok: true, verified: true });
    expect(fixture.getChangeCount()).toBeGreaterThan(0);
    expect(fixture.getValue()).toBe('12.5');
    fixture.unmount();
  });

  it('clears before typing when clear is set, as two distinct onChange values', async () => {
    const fixture = mountControlledInput('gps-lat-clear');
    const browser = executingBrowser();
    const selector = '[data-testid="gps-lat-clear"]';

    await evalInApp(browser, REACT_SAFE_SET_VALUE_SCRIPT, [selector, 'seed', false]);
    expect(fixture.getSeenValues()).toEqual(['seed']);

    await evalInApp(browser, REACT_SAFE_SET_VALUE_SCRIPT, [selector, '99', true]);
    // Deleting the clear branch would fire a single 'seed' -> '99' onChange
    // (one value); clearing first fires an intermediate '' onChange too.
    expect(fixture.getSeenValues()).toEqual(['seed', '', '99']);
    expect(fixture.getValue()).toBe('99');
    fixture.unmount();
  });

  it('does not clear when clear is unset, even typing over an existing value', async () => {
    const fixture = mountControlledInput('gps-lat-no-clear');
    const browser = executingBrowser();
    const selector = '[data-testid="gps-lat-no-clear"]';

    await evalInApp(browser, REACT_SAFE_SET_VALUE_SCRIPT, [selector, 'seed', false]);
    await evalInApp(browser, REACT_SAFE_SET_VALUE_SCRIPT, [selector, '99', false]);

    expect(fixture.getSeenValues()).toEqual(['seed', '99']);
    fixture.unmount();
  });

  it('reports verified against the settled post-render value, not the synchronous write', async () => {
    const fixture = mountEffectClampingInput('gps-lat-clamped', 3);
    const browser = executingBrowser();

    const result = await evalInApp<{ ok: boolean; verified: boolean }>(browser, REACT_SAFE_SET_VALUE_SCRIPT, [
      '[data-testid="gps-lat-clamped"]',
      '12345',
      false,
    ]);

    // The clamping effect is a passive effect - React schedules it rather
    // than flushing it inline with the input event, so a synchronous read
    // (no settle tick) would still see the full unclamped '12345' and
    // self-certify verified: true. Only the settle tick observes the clamp.
    expect(result.verified).toBe(false);
    expect(fixture.getValue()).toBe('123');
    fixture.unmount();
  });

  it('is required: naive value assignment does not reach React state', () => {
    const fixture = mountControlledInput('gps-lat-naive');
    naiveSetValue('[data-testid="gps-lat-naive"]', '12.5');

    expect(fixture.getChangeCount()).toBe(0);
    expect(fixture.getValue()).toBe('');
    fixture.unmount();
  });

  it('reports not-editable for a disabled input without writing to it', async () => {
    const fixture = mountControlledInput('gps-lat-disabled', { disabled: true });
    const browser = executingBrowser();

    const result = await evalInApp<{ ok: boolean; reason?: string }>(browser, REACT_SAFE_SET_VALUE_SCRIPT, [
      '[data-testid="gps-lat-disabled"]',
      '12.5',
      false,
    ]);

    expect(result).toEqual({ ok: false, reason: 'not-editable' });
    expect(fixture.getChangeCount()).toBe(0);
    fixture.unmount();
  });

  it('reports not-editable for a readOnly input without writing to it', async () => {
    const fixture = mountControlledInput('gps-lat-readonly', { readOnly: true });
    const browser = executingBrowser();

    const result = await evalInApp<{ ok: boolean; reason?: string }>(browser, REACT_SAFE_SET_VALUE_SCRIPT, [
      '[data-testid="gps-lat-readonly"]',
      '12.5',
      false,
    ]);

    expect(result).toEqual({ ok: false, reason: 'not-editable' });
    expect(fixture.getChangeCount()).toBe(0);
    fixture.unmount();
  });

  it('reports unsupported-element for a SELECT rather than certifying a write', async () => {
    const container = document.createElement('div');
    container.innerHTML = '<select data-testid="gps-unit"><option value="m">m</option></select>';
    document.body.appendChild(container);
    const browser = executingBrowser();

    const result = await evalInApp<{ ok: boolean; reason?: string }>(browser, REACT_SAFE_SET_VALUE_SCRIPT, [
      '[data-testid="gps-unit"]',
      'ft',
      false,
    ]);

    expect(result).toEqual({ ok: false, reason: 'unsupported-element' });
    container.remove();
  });

  it('reports not-found for a missing selector', async () => {
    const browser = executingBrowser();
    const result = await evalInApp<{ ok: boolean; reason?: string }>(browser, REACT_SAFE_SET_VALUE_SCRIPT, [
      '[data-testid="does-not-exist"]',
      'x',
      false,
    ]);
    expect(result).toEqual({ ok: false, reason: 'not-found' });
  });
});

describe('SYNTHETIC_KEY_SCRIPT', () => {
  it('dispatches a keydown/keyup Escape KeyboardEvent on the focused element', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    const seen: string[] = [];
    input.addEventListener('keydown', (e) => {
      if (e instanceof KeyboardEvent && e.key === 'Escape') seen.push('keydown');
    });
    input.addEventListener('keyup', (e) => {
      if (e instanceof KeyboardEvent && e.key === 'Escape') seen.push('keyup');
    });

    const browser = executingBrowser();
    await evalInApp(browser, SYNTHETIC_KEY_SCRIPT, ['Escape']);

    expect(seen).toEqual(['keydown', 'keyup']);
    input.remove();
  });

  it('dispatches an Enter KeyboardEvent when parameterized for submit', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    const seen: string[] = [];
    input.addEventListener('keydown', (e) => {
      if (e instanceof KeyboardEvent) seen.push(e.key);
    });

    const browser = executingBrowser();
    await evalInApp(browser, SYNTHETIC_KEY_SCRIPT, ['Enter']);

    expect(seen).toEqual(['Enter']);
    input.remove();
  });

  it('falls back to the #root container when nothing is focused', async () => {
    (document.activeElement as HTMLElement | null)?.blur();
    const root = document.createElement('div');
    root.id = 'root';
    document.body.appendChild(root);
    // React 18 attaches its delegated listener directly to the createRoot()
    // container - simulate that here instead of document, which sits above
    // #root and would never see an event dispatched at a node below it.
    const seen: string[] = [];
    root.addEventListener('keydown', (e) => {
      if (e instanceof KeyboardEvent && e.key === 'Escape') seen.push('keydown');
    });

    expect(document.activeElement === document.body || document.activeElement === null).toBe(true);

    const browser = executingBrowser();
    await evalInApp(browser, SYNTHETIC_KEY_SCRIPT, ['Escape']);

    expect(seen).toEqual(['keydown']);
    root.remove();
  });
});
