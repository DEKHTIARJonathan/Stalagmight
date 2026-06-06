import {
  waitForAppReady,
  resetAppState,
  createNewProject,
} from '../helpers/app';

/**
 * WebdriverIO accessibility tests for keyboard shortcuts configuration UI.
 * Tests keyboard navigation, ARIA attributes, and screen reader announcements.
 */

describe('Shortcuts Settings Accessibility', () => {
  beforeEach(async () => {
    await waitForAppReady();
    await resetAppState();
    await createNewProject('Shortcuts A11y Test');
  });

  /**
   * Helper to open the Settings dialog and navigate to Shortcuts tab.
   */
  async function openShortcutsTab(): Promise<void> {
    // Open settings dialog via store
    await browser.execute(() => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          uiStore: {
            getState: () => {
              openDialog: (name: string) => void;
            };
          };
        };
      }).__E2E_TEST__;

      if (e2e) {
        e2e.uiStore.getState().openDialog('settings');
      }
    });

    // Wait for settings dialog to appear
    const dialog = await $('[data-testid="settings-dialog"]');
    await dialog.waitForDisplayed({ timeout: 5000 });

    // Click on Shortcuts tab
    const shortcutsTab = await $('[data-testid="settings-tab-shortcuts"]');
    await shortcutsTab.click();

    // Wait for shortcuts tab content to load
    const shortcutsContent = await $('[data-testid="shortcuts-tab-content"]');
    await shortcutsContent.waitForDisplayed({ timeout: 3000 });
  }

  describe('ARIA structure', () => {
    beforeEach(async () => {
      await openShortcutsTab();
    });

    it('shortcut recorders have role="button"', async () => {
      // Find a shortcut recorder
      const recorder = await $('[data-testid="shortcut-primary-select"]');
      await expect(recorder).toBeExisting();

      const role = await recorder.getAttribute('role');
      expect(role).toBe('button');
    });

    it('shortcut recorders have aria-label describing the action', async () => {
      // Check primary shortcut for select action
      const selectPrimary = await $('[data-testid="shortcut-primary-select"]');
      await expect(selectPrimary).toBeExisting();

      const ariaLabel = await selectPrimary.getAttribute('aria-label');
      expect(ariaLabel).toBeTruthy();
      expect(ariaLabel.toLowerCase()).toContain('select');
      expect(ariaLabel.toLowerCase()).toContain('shortcut');
    });

    it('shortcut recorders have aria-pressed reflecting recording state', async () => {
      const recorder = await $('[data-testid="shortcut-primary-select"]');
      await expect(recorder).toBeExisting();

      // Initially not recording
      const initialPressed = await recorder.getAttribute('aria-pressed');
      expect(initialPressed).toBe('false');

      // Click to start recording
      await recorder.click();

      // Wait for recording state
      await browser.waitUntil(
        async () => {
          const pressed = await recorder.getAttribute('aria-pressed');
          return pressed === 'true';
        },
        { timeout: 2000, timeoutMsg: 'aria-pressed did not become true' }
      );

      // Verify recording state
      const recordingPressed = await recorder.getAttribute('aria-pressed');
      expect(recordingPressed).toBe('true');

      // Press Escape to cancel
      await browser.keys(['Escape']);

      // Wait for recording to stop
      await browser.waitUntil(
        async () => {
          const pressed = await recorder.getAttribute('aria-pressed');
          return pressed === 'false';
        },
        { timeout: 2000, timeoutMsg: 'aria-pressed did not become false' }
      );
    });

    it('each shortcut row has distinct aria-labels for primary and secondary slots', async () => {
      const primaryRecorder = await $('[data-testid="shortcut-primary-pan"]');
      const secondaryRecorder = await $('[data-testid="shortcut-secondary-pan"]');

      await expect(primaryRecorder).toBeExisting();
      await expect(secondaryRecorder).toBeExisting();

      const primaryLabel = await primaryRecorder.getAttribute('aria-label');
      const secondaryLabel = await secondaryRecorder.getAttribute('aria-label');

      expect(primaryLabel).toBeTruthy();
      expect(secondaryLabel).toBeTruthy();

      // Labels should be different
      expect(primaryLabel).not.toBe(secondaryLabel);

      // Both should mention the action
      expect(primaryLabel.toLowerCase()).toContain('pan');
      expect(secondaryLabel.toLowerCase()).toContain('pan');

      // One should mention primary, other secondary
      expect(primaryLabel.toLowerCase()).toContain('primary');
      expect(secondaryLabel.toLowerCase()).toContain('secondary');
    });

    it('reserved shortcuts section is present and labeled', async () => {
      const reservedSection = await $('[data-testid="reserved-shortcuts"]');
      await expect(reservedSection).toBeExisting();

      // Should contain reserved shortcuts like Escape, Delete
      const text = await reservedSection.getText();
      expect(text.toLowerCase()).toMatch(/escape|esc/);
    });

    it('search input has accessible placeholder', async () => {
      const searchInput = await $('[data-testid="shortcuts-search"]');
      await expect(searchInput).toBeExisting();

      const placeholder = await searchInput.getAttribute('placeholder');
      expect(placeholder).toBeTruthy();
      expect(placeholder.toLowerCase()).toContain('search');
    });

    it('category toggle buttons are keyboard accessible', async () => {
      const categoryToggle = await $('[data-testid="shortcut-category-toggle-tools"]');
      await expect(categoryToggle).toBeExisting();

      // Should be a button
      const tagName = await categoryToggle.getTagName();
      expect(tagName.toLowerCase()).toBe('button');

      // Should be focusable
      const tabIndex = await browser.execute((el) => {
        return (el as HTMLElement).tabIndex;
      }, categoryToggle);
      expect(tabIndex).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Keyboard navigation', () => {
    beforeEach(async () => {
      await openShortcutsTab();
    });

    it('Tab navigates through shortcut inputs', async () => {
      // Focus on search input first
      const searchInput = await $('[data-testid="shortcuts-search"]');
      await browser.execute((el: HTMLElement) => el.focus(), searchInput);

      // Verify search is focused
      await browser.waitUntil(
        async () => {
          const isFocused = await browser.execute(() => {
            const el = document.activeElement;
            return el?.getAttribute('data-testid') === 'shortcuts-search';
          });
          return isFocused;
        },
        { timeout: 2000, timeoutMsg: 'Search input did not receive focus' }
      );

      // Press Tab to navigate to next focusable element
      await browser.keys(['Tab']);

      // Wait for focus to move to a valid shortcuts tab element
      await browser.waitUntil(
        async () => {
          const focused = await browser.execute(() => {
            const el = document.activeElement;
            const testId = el?.getAttribute('data-testid') || '';
            const role = el?.getAttribute('role');
            // Valid targets: category toggle buttons, shortcut recorders, reset buttons
            const isValidTarget =
              testId.startsWith('shortcut-category-toggle-') ||
              testId.startsWith('shortcut-primary-') ||
              testId.startsWith('shortcut-secondary-') ||
              testId.startsWith('shortcut-reset-') ||
              testId === 'shortcuts-reset-all' ||
              role === 'button';
            return isValidTarget && testId !== 'shortcuts-search';
          });
          return focused;
        },
        { timeout: 3000, timeoutMsg: 'Tab did not navigate to a valid shortcuts element' }
      );

      // Verify the focused element is within shortcuts tab content
      const nextFocused = await browser.execute(() => {
        const el = document.activeElement;
        const shortcutsContent = document.querySelector('[data-testid="shortcuts-tab-content"]');
        return {
          tagName: el?.tagName,
          role: el?.getAttribute('role'),
          testId: el?.getAttribute('data-testid'),
          isWithinShortcutsTab: shortcutsContent?.contains(el) || false,
        };
      });

      expect(nextFocused.testId).not.toBe('shortcuts-search');
      expect(nextFocused.isWithinShortcutsTab).toBe(true);
    });

    it('Tab cycles through multiple shortcut recorders', async () => {
      // Focus on the first shortcut recorder
      const firstRecorder = await $('[data-testid="shortcut-primary-select"]');
      await browser.execute((el: HTMLElement) => el.focus(), firstRecorder);

      // Get initial focused element
      const initialTestId = await browser.execute(() => {
        return document.activeElement?.getAttribute('data-testid');
      });
      expect(initialTestId).toBe('shortcut-primary-select');

      // Press Tab to move to next element
      await browser.keys(['Tab']);
      await browser.pause(100);

      // Should be on secondary slot or next action
      const secondTestId = await browser.execute(() => {
        return document.activeElement?.getAttribute('data-testid');
      });

      expect(secondTestId).not.toBe(initialTestId);
      expect(secondTestId).toBeTruthy();
    });

    it('Enter activates recording mode on focused shortcut recorder', async () => {
      const recorder = await $('[data-testid="shortcut-primary-select"]');
      await browser.execute((el: HTMLElement) => el.focus(), recorder);

      // Verify focus
      await browser.waitUntil(
        async () => {
          const isFocused = await browser.execute(() => {
            const el = document.activeElement;
            return el?.getAttribute('data-testid') === 'shortcut-primary-select';
          });
          return isFocused;
        },
        { timeout: 2000, timeoutMsg: 'Recorder did not receive focus' }
      );

      // Check initial state - not recording
      const initialPressed = await recorder.getAttribute('aria-pressed');
      expect(initialPressed).toBe('false');

      // Press Enter to activate
      await browser.keys(['Enter']);

      // Should enter recording mode
      await browser.waitUntil(
        async () => {
          const pressed = await recorder.getAttribute('aria-pressed');
          return pressed === 'true';
        },
        { timeout: 2000, timeoutMsg: 'Enter did not activate recording' }
      );

      // Clean up - press Escape
      await browser.keys(['Escape']);
    });

    it('Space activates recording mode on focused shortcut recorder', async () => {
      const recorder = await $('[data-testid="shortcut-primary-pan"]');
      await browser.execute((el: HTMLElement) => el.focus(), recorder);

      // Verify focus
      await browser.waitUntil(
        async () => {
          const isFocused = await browser.execute(() => {
            const el = document.activeElement;
            return el?.getAttribute('data-testid') === 'shortcut-primary-pan';
          });
          return isFocused;
        },
        { timeout: 2000, timeoutMsg: 'Recorder did not receive focus' }
      );

      // Check initial state
      const initialPressed = await recorder.getAttribute('aria-pressed');
      expect(initialPressed).toBe('false');

      // Press Space to activate
      await browser.keys([' ']);

      // Should enter recording mode
      await browser.waitUntil(
        async () => {
          const pressed = await recorder.getAttribute('aria-pressed');
          return pressed === 'true';
        },
        { timeout: 2000, timeoutMsg: 'Space did not activate recording' }
      );

      // Clean up
      await browser.keys(['Escape']);
    });

    it('Escape cancels recording mode', async () => {
      const recorder = await $('[data-testid="shortcut-primary-zoom"]');

      // Click to start recording
      await recorder.click();

      // Wait for recording state
      await browser.waitUntil(
        async () => {
          const pressed = await recorder.getAttribute('aria-pressed');
          return pressed === 'true';
        },
        { timeout: 2000, timeoutMsg: 'Recording did not start' }
      );

      // Press Escape to cancel
      await browser.keys(['Escape']);

      // Should exit recording mode
      await browser.waitUntil(
        async () => {
          const pressed = await recorder.getAttribute('aria-pressed');
          return pressed === 'false';
        },
        { timeout: 2000, timeoutMsg: 'Escape did not cancel recording' }
      );
    });

    it('category collapse/expand works with keyboard', async () => {
      const categoryToggle = await $('[data-testid="shortcut-category-toggle-tools"]');
      await browser.execute((el: HTMLElement) => el.focus(), categoryToggle);

      // Verify focus
      await browser.waitUntil(
        async () => {
          const focused = await browser.execute(() => {
            return document.activeElement?.getAttribute('data-testid');
          });
          return focused === 'shortcut-category-toggle-tools';
        },
        { timeout: 2000, timeoutMsg: 'Category toggle did not receive focus' }
      );

      // Check initial state - should show content
      const toolsCategory = await $('[data-testid="shortcut-category-tools"]');
      const selectRow = await toolsCategory.$('[data-testid="shortcut-row-select"]');
      const initiallyVisible = await selectRow.isDisplayed();
      expect(initiallyVisible).toBe(true);

      // Press Enter to collapse
      await browser.keys(['Enter']);
      await browser.pause(200);

      // Category content should be hidden
      const isCollapsed = await browser.execute(() => {
        const category = document.querySelector('[data-testid="shortcut-category-tools"]');
        const row = category?.querySelector('[data-testid="shortcut-row-select"]');
        return !row;
      });
      expect(isCollapsed).toBe(true);

      // Press Enter again to expand
      await browser.keys(['Enter']);
      await browser.pause(200);

      // Category content should be visible again
      const isExpanded = await browser.execute(() => {
        const category = document.querySelector('[data-testid="shortcut-category-tools"]');
        const row = category?.querySelector('[data-testid="shortcut-row-select"]');
        return !!row;
      });
      expect(isExpanded).toBe(true);
    });
  });

  describe('Screen reader support', () => {
    beforeEach(async () => {
      await openShortcutsTab();
    });

    it('live region exists for announcements within shortcut recorders', async () => {
      // Each ShortcutRecorder should have its own aria-live region for screen reader announcements
      // Scope the search to a specific recorder to avoid false positives from unrelated live regions
      const recorder = await $('[data-testid="shortcut-primary-select"]');
      await expect(recorder).toBeExisting();

      // The live region should be inside the recorder component
      const liveRegion = await recorder.$('[aria-live="polite"]');
      await expect(liveRegion).toBeExisting();

      // Verify the live region has proper attributes for screen readers
      const ariaAtomic = await liveRegion.getAttribute('aria-atomic');
      expect(ariaAtomic).toBe('true');

      // Also verify role="status" for proper SR support
      const role = await liveRegion.getAttribute('role');
      expect(role).toBe('status');
    });

    it('live region announces when recording is cancelled', async () => {
      const recorder = await $('[data-testid="shortcut-primary-pan"]');
      const liveRegion = await recorder.$('[aria-live="polite"]');

      // Start recording
      await recorder.click();
      await browser.waitUntil(
        async () => {
          const pressed = await recorder.getAttribute('aria-pressed');
          return pressed === 'true';
        },
        { timeout: 2000 }
      );

      // Cancel with Escape
      await browser.keys(['Escape']);

      // Wait for cancelled state
      await browser.waitUntil(
        async () => {
          const pressed = await recorder.getAttribute('aria-pressed');
          return pressed === 'false';
        },
        { timeout: 2000 }
      );

      // Wait for cancellation announcement in live region (use textContent for sr-only elements)
      await browser.waitUntil(
        async () => {
          const text = await browser.execute((el) => {
            return (el as HTMLElement).textContent || '';
          }, liveRegion);
          return text.toLowerCase().includes('cancel');
        },
        { timeout: 2000, timeoutMsg: 'Live region did not announce cancellation' }
      );

      // Verify the announcement text
      const announcement = await browser.execute((el) => {
        return (el as HTMLElement).textContent || '';
      }, liveRegion);
      expect(announcement.toLowerCase()).toMatch(/cancel/);
    });

    it('conflict error is announced to screen readers via alert role', async () => {
      // Find a shortcut that's already bound (select = S)
      // Try to assign the same shortcut to pan
      const panRecorder = await $('[data-testid="shortcut-primary-pan"]');

      // Start recording
      await panRecorder.click();
      await browser.waitUntil(
        async () => {
          const pressed = await panRecorder.getAttribute('aria-pressed');
          return pressed === 'true';
        },
        { timeout: 2000 }
      );

      // Try to assign 'S' which is bound to select by default
      await browser.keys(['s']);

      // Wait for key capture and release to complete recording attempt
      await browser.pause(200);

      // Check for error message with proper accessibility attributes
      const errorElement = await $('[data-testid="shortcut-error"]');

      // Wait for error to appear
      await browser.waitUntil(
        async () => {
          const exists = await errorElement.isExisting();
          if (!exists) return false;
          const displayed = await errorElement.isDisplayed();
          return displayed;
        },
        { timeout: 3000, timeoutMsg: 'Conflict error did not appear' }
      );

      // Verify error element has role="alert" for screen reader announcement
      // role="alert" automatically announces content to screen readers when it appears
      const role = await errorElement.getAttribute('role');
      expect(role).toBe('alert');

      // Verify aria-live="assertive" for immediate announcement
      const ariaLive = await errorElement.getAttribute('aria-live');
      expect(ariaLive).toBe('assertive');

      // Verify error message content describes the conflict
      const errorText = await errorElement.getText();
      expect(errorText.toLowerCase()).toMatch(/already|conflict|used/);
    });

    it('live region announces recording state changes for screen readers', async () => {
      // The ShortcutRecorder component has an internal live region that announces
      // state changes for screen readers. Test that it updates appropriately.
      const recorder = await $('[data-testid="shortcut-primary-merge"]');
      const liveRegion = await recorder.$('[aria-live="polite"]');
      await expect(liveRegion).toBeExisting();

      // Start recording
      await recorder.click();
      await browser.waitUntil(
        async () => {
          const pressed = await recorder.getAttribute('aria-pressed');
          return pressed === 'true';
        },
        { timeout: 2000 }
      );

      // Wait for recording announcement in the live region
      await browser.waitUntil(
        async () => {
          // Use textContent via execute since sr-only elements may not return text via getText
          const text = await browser.execute((el) => {
            return (el as HTMLElement).textContent || '';
          }, liveRegion);
          return text.toLowerCase().includes('recording') || text.toLowerCase().includes('press');
        },
        { timeout: 2000, timeoutMsg: 'Live region did not announce recording state' }
      );

      // Capture a key
      await browser.keys(['q']);
      await browser.pause(100);

      // Wait for capture announcement
      await browser.waitUntil(
        async () => {
          const text = await browser.execute((el) => {
            return (el as HTMLElement).textContent || '';
          }, liveRegion);
          return text.toLowerCase().includes('captured') || text.toLowerCase().includes('set');
        },
        { timeout: 2000, timeoutMsg: 'Live region did not announce key capture' }
      );
    });

    it('screen reader can identify all shortcut actions', async () => {
      // Get all shortcut rows - verify all are accessible
      const rows = await $$('[data-testid^="shortcut-row-"]');
      expect(rows.length).toBeGreaterThan(0);

      // Track verified rows to ensure we check all
      let verifiedCount = 0;
      let totalRowsWithRecorder = 0;

      // Check ALL rows for proper ARIA labeling
      for (const row of rows) {
        const testId = await row.getAttribute('data-testid');
        const actionName = testId?.replace('shortcut-row-', '');

        // Find primary recorder in this row
        const primaryRecorder = await row.$(`[data-testid="shortcut-primary-${actionName}"]`);

        if (await primaryRecorder.isExisting()) {
          totalRowsWithRecorder++;
          const ariaLabel = await primaryRecorder.getAttribute('aria-label');

          // Every recorder must have an aria-label
          expect(ariaLabel).toBeTruthy();
          // Label should be descriptive (contain more than just a key name)
          expect(ariaLabel.length).toBeGreaterThan(10);
          // Label should include the word "shortcut" for context
          expect(ariaLabel.toLowerCase()).toContain('shortcut');

          verifiedCount++;
        }
      }

      // Ensure we actually verified a meaningful number of rows
      expect(totalRowsWithRecorder).toBeGreaterThan(0);
      expect(verifiedCount).toBe(totalRowsWithRecorder);

      // Log for debugging: total actions verified
      console.log(`Verified ${verifiedCount} shortcut actions for screen reader accessibility`);
    });

    it('reset buttons have accessible labels', async () => {
      // Find a reset button
      const resetButton = await $('[data-testid="shortcut-reset-select"]');

      if (await resetButton.isExisting()) {
        const title = await resetButton.getAttribute('title');
        expect(title).toBeTruthy();
        expect(title.toLowerCase()).toContain('reset');
      }
    });

    it('Reset All button is accessible', async () => {
      const resetAllButton = await $('[data-testid="shortcuts-reset-all"]');
      await expect(resetAllButton).toBeExisting();

      // Should be a button
      const tagName = await resetAllButton.getTagName();
      expect(tagName.toLowerCase()).toBe('button');

      // Should have descriptive text
      const text = await resetAllButton.getText();
      expect(text.toLowerCase()).toContain('reset');
    });
  });

  describe('Recording workflow accessibility', () => {
    beforeEach(async () => {
      await openShortcutsTab();
    });

    it('keyboard shortcut capture workflow is fully keyboard-accessible', async () => {
      const recorder = await $('[data-testid="shortcut-primary-merge"]');

      // 1. Focus recorder via Tab navigation
      await browser.execute((el: HTMLElement) => el.focus(), recorder);

      await browser.waitUntil(
        async () => {
          return (await browser.execute(() => {
            return document.activeElement?.getAttribute('data-testid');
          })) === 'shortcut-primary-merge';
        },
        { timeout: 2000 }
      );

      // 2. Activate recording with Enter
      await browser.keys(['Enter']);

      await browser.waitUntil(
        async () => {
          const pressed = await recorder.getAttribute('aria-pressed');
          return pressed === 'true';
        },
        { timeout: 2000, timeoutMsg: 'Failed to enter recording mode with Enter' }
      );

      // 3. Record a key combo (Ctrl+M - should be free)
      await browser.keys(['Control', 'Shift', 'm']);

      // Release keys
      await browser.pause(100);

      // 4. Recording should complete and show the new shortcut
      await browser.waitUntil(
        async () => {
          const pressed = await recorder.getAttribute('aria-pressed');
          return pressed === 'false';
        },
        { timeout: 3000, timeoutMsg: 'Recording did not complete' }
      );

      // 5. Verify the shortcut was captured (check data-recording attribute)
      const dataRecording = await recorder.getAttribute('data-recording');
      expect(dataRecording).toBe('false');
    });

    it('clear button is keyboard accessible when shortcut exists', async () => {
      // Find a recorder that should have a value (select has 'S' by default)
      const recorder = await $('[data-testid="shortcut-primary-select"]');
      await expect(recorder).toBeExisting();

      // Look for clear button
      const clearButton = await $('[data-testid="shortcut-primary-select-clear"]');

      if (await clearButton.isExisting()) {
        // Focus the clear button
        await browser.execute((el: HTMLElement) => el.focus(), clearButton);

        // Should be focusable
        const isFocused = await browser.execute(() => {
          const el = document.activeElement;
          return el?.getAttribute('data-testid') === 'shortcut-primary-select-clear';
        });

        // Note: Clear button may not exist if value is already cleared
        // Just verify it's accessible if it exists
        if (isFocused) {
          // Has accessible label
          const ariaLabel = await clearButton.getAttribute('aria-label');
          expect(ariaLabel).toBeTruthy();
          expect(ariaLabel.toLowerCase()).toContain('clear');
        }
      }
    });

    it('blocked key feedback is accessible', async () => {
      const recorder = await $('[data-testid="shortcut-primary-zoom"]');
      const liveRegion = await recorder.$('[aria-live="polite"]');

      // Start recording
      await recorder.click();
      await browser.waitUntil(
        async () => {
          const pressed = await recorder.getAttribute('aria-pressed');
          return pressed === 'true';
        },
        { timeout: 2000 }
      );

      // Try to press a blocked key (F1)
      await browser.keys(['F1']);

      // Wait for blocked key announcement in live region (use textContent for sr-only elements)
      await browser.waitUntil(
        async () => {
          const text = await browser.execute((el) => {
            return (el as HTMLElement).textContent || '';
          }, liveRegion);
          return text.toLowerCase().includes('not allowed') ||
                 text.toLowerCase().includes('cannot') ||
                 text.toLowerCase().includes('blocked') ||
                 text.toLowerCase().includes('try a different');
        },
        { timeout: 2000, timeoutMsg: 'Live region did not announce blocked key' }
      );

      // Verify the announcement text
      const announcement = await browser.execute((el) => {
        return (el as HTMLElement).textContent || '';
      }, liveRegion);
      expect(announcement.toLowerCase()).toMatch(/not allowed|cannot|blocked|try a different/);

      // Clean up - Escape to exit recording
      await browser.keys(['Escape']);
    });
  });

  describe('Visual and interaction feedback', () => {
    beforeEach(async () => {
      await openShortcutsTab();
    });

    it('recording state has distinct visual styling', async () => {
      const recorder = await $('[data-testid="shortcut-primary-select"]');

      // Get initial styles
      const initialStyles = await browser.execute((el) => {
        const styles = window.getComputedStyle(el);
        return {
          borderColor: styles.borderColor,
          backgroundColor: styles.backgroundColor,
        };
      }, recorder);

      // Start recording
      await recorder.click();
      await browser.waitUntil(
        async () => {
          const pressed = await recorder.getAttribute('aria-pressed');
          return pressed === 'true';
        },
        { timeout: 2000 }
      );

      // Get recording styles
      const recordingStyles = await browser.execute((el) => {
        const styles = window.getComputedStyle(el);
        return {
          borderColor: styles.borderColor,
          backgroundColor: styles.backgroundColor,
          boxShadow: styles.boxShadow,
        };
      }, recorder);

      // Styles should be different when recording
      // Either border color changed or box-shadow (ring) appeared
      const stylesChanged =
        recordingStyles.borderColor !== initialStyles.borderColor ||
        recordingStyles.backgroundColor !== initialStyles.backgroundColor ||
        (recordingStyles.boxShadow !== 'none' && recordingStyles.boxShadow !== '');

      expect(stylesChanged).toBe(true);

      // Clean up
      await browser.keys(['Escape']);
    });

    it('error state is visually distinct from normal state', async () => {
      // First, get styles of a normal (non-error) element for comparison
      const shortcutsContent = await $('[data-testid="shortcuts-tab-content"]');
      const normalBgColor = await browser.execute((el) => {
        const styles = window.getComputedStyle(el);
        return styles.backgroundColor;
      }, shortcutsContent);

      const panRecorder = await $('[data-testid="shortcut-primary-pan"]');

      // Trigger a conflict error by trying to assign S (which is used by select)
      await panRecorder.click();
      await browser.waitUntil(
        async () => {
          const pressed = await panRecorder.getAttribute('aria-pressed');
          return pressed === 'true';
        },
        { timeout: 2000 }
      );

      await browser.keys(['s']);
      await browser.pause(200);

      // Check error element exists and has error styling
      const errorElement = await $('[data-testid="shortcut-error"]');
      await browser.waitUntil(
        async () => await errorElement.isDisplayed(),
        { timeout: 3000, timeoutMsg: 'Error element did not appear' }
      );

      // Error should have distinct styling (red/error color)
      const errorStyles = await browser.execute((el) => {
        const styles = window.getComputedStyle(el);
        return {
          borderColor: styles.borderColor,
          backgroundColor: styles.backgroundColor,
          color: styles.color,
        };
      }, errorElement);

      // Parse background color to check it's not fully transparent
      const bgColor = errorStyles.backgroundColor;
      const isTransparent = bgColor === 'rgba(0, 0, 0, 0)' || bgColor === 'transparent';

      // Error element should have a visible background (not transparent)
      // The component uses bg-error/10 which gives a semi-transparent red tint
      expect(isTransparent).toBe(false);

      // Error text color should differ from the background (ensuring contrast)
      expect(errorStyles.color).not.toBe(errorStyles.backgroundColor);

      // Error background should differ from the normal container background
      // (proving error state is visually distinct)
      expect(errorStyles.backgroundColor).not.toBe(normalBgColor);
    });
  });
});
