// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createElement, useState, type ChangeEvent } from 'react';
import { render } from '@testing-library/react';
import type { Browser } from 'webdriverio';

import { evalInApp } from './page';
import { REACT_SAFE_SET_VALUE_SCRIPT, SYNTHETIC_ESCAPE_KEYDOWN_SCRIPT } from './reactInput';

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

function mountControlledInput(testid: string) {
  let lastValue = '';
  let changeCount = 0;

  function Fixture() {
    const [value, setValue] = useState('');
    lastValue = value;
    return createElement('input', {
      'data-testid': testid,
      value,
      onChange: (e: ChangeEvent<HTMLInputElement>) => {
        changeCount += 1;
        setValue(e.target.value);
      },
    });
  }

  const { unmount } = render(createElement(Fixture));

  return {
    getValue: () => lastValue,
    getChangeCount: () => changeCount,
    unmount,
  };
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

  it('clears before typing when clear is set', async () => {
    const fixture = mountControlledInput('gps-lat-clear');
    const browser = executingBrowser();
    const selector = '[data-testid="gps-lat-clear"]';

    await evalInApp(browser, REACT_SAFE_SET_VALUE_SCRIPT, [selector, 'seed', false]);
    expect(fixture.getValue()).toBe('seed');

    await evalInApp(browser, REACT_SAFE_SET_VALUE_SCRIPT, [selector, '99', true]);
    expect(fixture.getValue()).toBe('99');
    fixture.unmount();
  });

  it('is required: naive value assignment does not reach React state', () => {
    const fixture = mountControlledInput('gps-lat-naive');
    naiveSetValue('[data-testid="gps-lat-naive"]', '12.5');

    expect(fixture.getChangeCount()).toBe(0);
    expect(fixture.getValue()).toBe('');
    fixture.unmount();
  });
});

describe('SYNTHETIC_ESCAPE_KEYDOWN_SCRIPT', () => {
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
    await evalInApp(browser, SYNTHETIC_ESCAPE_KEYDOWN_SCRIPT);

    expect(seen).toEqual(['keydown', 'keyup']);
    input.remove();
  });
});
