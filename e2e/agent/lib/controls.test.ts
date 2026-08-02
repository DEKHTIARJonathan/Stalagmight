import { beforeEach, describe, expect, it, vi } from 'vitest';

const evalInAppMock = vi.hoisted(() => vi.fn());
vi.mock('./page', () => ({ evalInApp: evalInAppMock }));

import { hoverElement, queueFileDialogAnswer, selectOption, targetSelector, testIdSelector } from './controls';
import type { Browser } from 'webdriverio';

function fakeBrowser(elements: Record<string, Record<string, ReturnType<typeof vi.fn>>>) {
  return {
    $: vi.fn((selector: string) => elements[selector]),
  } as unknown as Browser;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('agent controls', () => {
  it('builds safe target selectors and hovers the resolved element', async () => {
    const selector = testIdSelector('C:\\Caves\\"survey"');
    const element = { waitForDisplayed: vi.fn(), moveTo: vi.fn() };
    const browser = fakeBrowser({ [selector]: element });

    expect(targetSelector({ testid: 'C:\\Caves\\"survey"' })).toBe(selector);
    await expect(hoverElement(browser, { testid: 'C:\\Caves\\"survey"' })).resolves.toBe(selector);
    expect(element.waitForDisplayed).toHaveBeenCalledWith({ timeout: 5000 });
    expect(element.moveTo).toHaveBeenCalledOnce();
  });

  it('selects a custom option through its encoded option test ID', async () => {
    const triggerSelector = '[data-testid="format-select"]';
    const optionSelector = '[data-testid="format-select-option-value%2Fwith%20space"]';
    const trigger = {
      waitForDisplayed: vi.fn(),
      getTagName: vi.fn().mockResolvedValue('button'),
      getAttribute: vi.fn().mockResolvedValue('format-select'),
      waitForClickable: vi.fn(),
      click: vi.fn(),
    };
    const option = { waitForClickable: vi.fn(), click: vi.fn() };
    const browser = fakeBrowser({ [triggerSelector]: trigger, [optionSelector]: option });

    await selectOption(browser, { testid: 'format-select', value: 'value/with space' });
    expect(trigger.click).toHaveBeenCalledOnce();
    expect(option.waitForClickable).toHaveBeenCalledWith({ timeout: 5000 });
    expect(option.click).toHaveBeenCalledOnce();
  });

  it('queues a native-dialog answer through the E2E hook', async () => {
    evalInAppMock.mockResolvedValue(true);
    const browser = fakeBrowser({});
    await queueFileDialogAnswer(browser, 'open', 'C:\\Caves\\survey.dmp');
    expect(evalInAppMock).toHaveBeenCalledWith(
      browser,
      expect.stringContaining('fileDialogAnswers'),
      ['open', 'C:\\Caves\\survey.dmp'],
    );
  });

  it('fails clearly when the app was not built with E2E hooks', async () => {
    evalInAppMock.mockResolvedValue(false);
    await expect(queueFileDialogAnswer(fakeBrowser({}), 'save', null)).rejects.toThrow(
      'file dialog hooks are unavailable',
    );
  });
});
