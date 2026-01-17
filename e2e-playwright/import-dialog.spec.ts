import { test, expect, Page } from '@playwright/test';
import { setupTauriMocks } from './mocks/tauri-ipc';

/**
 * Helper to create a project and open the import dialog.
 * Returns when the DMP file is loaded and sections are visible.
 */
async function createProjectAndOpenImportDialog(page: Page): Promise<void> {
  // Create a new project
  const newProjectBtn = page.locator('button:has-text("New Project"), h3:has-text("New Project")').first();
  await newProjectBtn.click();
  await page.waitForSelector('.fixed.inset-0');
  await page.locator('.fixed.inset-0 input').first().fill('LRUD Test Project');
  await page.click('.fixed.inset-0 button:has-text("Create")');
  await page.waitForSelector('canvas', { timeout: 10000 });

  // Open import dialog with Ctrl+I
  await page.keyboard.press('Control+i');
  await page.waitForSelector('[role="dialog"]', { timeout: 5000 });

  // The dialog is now open. Click Browse to trigger file dialog.
  // The mock returns '/mock/test-survey.dmp' and then import_dmp is called automatically.
  const dialog = page.locator('[role="dialog"]');
  await expect(dialog).toBeVisible();

  // Click Browse button to open file dialog (mock returns a path and auto-loads)
  const browseButton = dialog.locator('button:has-text("Browse...")');
  await browseButton.click();

  // Wait for sections to load - the data loads automatically after Browse returns a path
  // The mock parse_dmp returns data including "Main Passage" section
  await page.waitForSelector('text=Main Passage', { timeout: 5000 });

  // Verify the version info is shown (confirms data is loaded)
  await expect(dialog.locator('text=Version 5')).toBeVisible();
}

test.describe('Import Dialog UI', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    // Wait for app to load
    await page.waitForLoadState('networkidle');
  });

  test('should display the start page on load', async ({ page }) => {
    // Look for CaveChef title in header
    const title = page.locator('h1:has-text("CaveChef")');
    await expect(title).toBeVisible({ timeout: 10000 });
  });

  test('should open new project dialog', async ({ page }) => {
    // Click New Project card or button (could be in header or empty state)
    const newProjectBtn = page.locator('button:has-text("New Project"), h3:has-text("New Project")').first();
    await newProjectBtn.click();

    // Wait for dialog to appear (look for the dialog title h2)
    const dialogTitle = page.locator('h2:has-text("New Project")');
    await expect(dialogTitle).toBeVisible({ timeout: 5000 });
  });

  test('should create a new project', async ({ page }) => {
    // Click New Project (either button or card)
    const newProjectBtn = page.locator('button:has-text("New Project"), h3:has-text("New Project")').first();
    await newProjectBtn.click();

    // Wait for dialog
    await page.waitForSelector('.fixed.inset-0');

    // Fill in project name
    const nameInput = page.locator('.fixed.inset-0 input').first();
    await nameInput.fill('E2E Test Project');

    // Click Create button
    await page.click('.fixed.inset-0 button:has-text("Create")');

    // Wait for SingleSystemView (map/canvas should appear)
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 10000 });
  });

  test('should open import dialog with Ctrl+I', async ({ page }) => {
    // First create a project
    const newProjectBtn = page.locator('button:has-text("New Project"), h3:has-text("New Project")').first();
    await newProjectBtn.click();
    await page.waitForSelector('.fixed.inset-0');
    await page.locator('.fixed.inset-0 input').first().fill('Import Test Project');
    await page.click('.fixed.inset-0 button:has-text("Create")');

    // Wait for project view
    await page.waitForSelector('canvas', { timeout: 10000 });

    // Open import dialog with keyboard shortcut
    await page.keyboard.press('Control+i');

    // Verify import dialog appears
    const importDialog = page.locator('.fixed.inset-0');
    await expect(importDialog).toBeVisible({ timeout: 5000 });

    // Check for Import-related text in dialog
    const dialogText = await importDialog.textContent();
    expect(dialogText?.toLowerCase()).toContain('import');
  });

  test('should close dialog with Cancel button', async ({ page }) => {
    // Create project and open import dialog
    const newProjectBtn = page.locator('button:has-text("New Project"), h3:has-text("New Project")').first();
    await newProjectBtn.click();
    await page.waitForSelector('.fixed.inset-0');
    await page.locator('.fixed.inset-0 input').first().fill('Cancel Test Project');
    await page.click('.fixed.inset-0 button:has-text("Create")');
    await page.waitForSelector('canvas', { timeout: 10000 });

    // Open import dialog
    await page.keyboard.press('Control+i');
    await page.waitForSelector('.fixed.inset-0');

    // Close with Cancel button
    await page.click('.fixed.inset-0 button:has-text("Cancel")');

    // Dialog should be closed
    const dialog = page.locator('.fixed.inset-0');
    await expect(dialog).not.toBeVisible({ timeout: 3000 });
  });

  test('should have section name input in import dialog', async ({ page }) => {
    // Setup: create project and open import dialog
    const newProjectBtn = page.locator('button:has-text("New Project"), h3:has-text("New Project")').first();
    await newProjectBtn.click();
    await page.waitForSelector('.fixed.inset-0');
    await page.locator('.fixed.inset-0 input').first().fill('Section Name Test');
    await page.click('.fixed.inset-0 button:has-text("Create")');
    await page.waitForSelector('canvas', { timeout: 10000 });
    await page.keyboard.press('Control+i');

    // Find input field for section name
    const sectionInput = page.locator(
      '.fixed.inset-0 input'
    );

    // Should have at least one input field
    await expect(sectionInput.first()).toBeVisible({ timeout: 5000 });
  });
});

test.describe('LRUD Columns', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('section rows are expandable', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    // Find the expand button for the first section (Main Passage - index 0)
    const expandButton = page.locator('[data-testid="section-expand-0"]');
    await expect(expandButton).toBeVisible();

    // Initially collapsed (shows right arrow)
    await expect(expandButton).toHaveText('▶');

    // Click to expand
    await expandButton.click();

    // Now expanded (shows down arrow)
    await expect(expandButton).toHaveText('▼');

    // Shot rows should be visible
    const shotRow = page.locator('[data-testid="shot-row-0-0"]');
    await expect(shotRow).toBeVisible();
  });

  test('LRUD columns visible in shot preview', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    // Expand first section
    const expandButton = page.locator('[data-testid="section-expand-0"]');
    await expandButton.click();

    // Verify LRUD column headers are visible (use exact text match)
    const dialog = page.locator('[role="dialog"]');
    // These are in the nested table for shot details
    await expect(dialog.locator('th', { hasText: /^L$/ })).toBeVisible();
    await expect(dialog.locator('th', { hasText: /^R$/ })).toBeVisible();
    await expect(dialog.locator('th', { hasText: /^U$/ })).toBeVisible();
    await expect(dialog.locator('th', { hasText: /^D$/ })).toBeVisible();

    // Verify LRUD cells exist with data-testid
    await expect(page.locator('[data-testid="lrud-left-0-0"]')).toBeVisible();
    await expect(page.locator('[data-testid="lrud-right-0-0"]')).toBeVisible();
    await expect(page.locator('[data-testid="lrud-up-0-0"]')).toBeVisible();
    await expect(page.locator('[data-testid="lrud-down-0-0"]')).toBeVisible();
  });

  test('correct LRUD values displayed', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    // Expand first section (Main Passage)
    const expandButton = page.locator('[data-testid="section-expand-0"]');
    await expandButton.click();

    // First shot has LRUD values: left=1.5, right=2.3, up=3.0, down=0.8
    await expect(page.locator('[data-testid="lrud-left-0-0"]')).toHaveText('1.5');
    await expect(page.locator('[data-testid="lrud-right-0-0"]')).toHaveText('2.3');
    await expect(page.locator('[data-testid="lrud-up-0-0"]')).toHaveText('3.0');
    await expect(page.locator('[data-testid="lrud-down-0-0"]')).toHaveText('0.8');

    // Second shot has LRUD values: left=0.5, right=0.7, up=1.2, down=1.5
    await expect(page.locator('[data-testid="lrud-left-0-1"]')).toHaveText('0.5');
    await expect(page.locator('[data-testid="lrud-right-0-1"]')).toHaveText('0.7');
    await expect(page.locator('[data-testid="lrud-up-0-1"]')).toHaveText('1.2');
    await expect(page.locator('[data-testid="lrud-down-0-1"]')).toHaveText('1.5');
  });

  test('zero LRUD shows as dash', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    // Expand second section (Side Tunnel - has all zero LRUD values)
    const expandButton = page.locator('[data-testid="section-expand-1"]');
    await expandButton.click();

    // All LRUD values should show as dash for zero values
    await expect(page.locator('[data-testid="lrud-left-1-0"]')).toHaveText('-');
    await expect(page.locator('[data-testid="lrud-right-1-0"]')).toHaveText('-');
    await expect(page.locator('[data-testid="lrud-up-1-0"]')).toHaveText('-');
    await expect(page.locator('[data-testid="lrud-down-1-0"]')).toHaveText('-');
  });

  test('mixed LRUD values - some with data, some without', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    // Expand third section (Mixed LRUD Section)
    const expandButton = page.locator('[data-testid="section-expand-2"]');
    await expandButton.click();

    // First shot: left=2.5, right=0, up=4.0, down=0
    await expect(page.locator('[data-testid="lrud-left-2-0"]')).toHaveText('2.5');
    await expect(page.locator('[data-testid="lrud-right-2-0"]')).toHaveText('-');
    await expect(page.locator('[data-testid="lrud-up-2-0"]')).toHaveText('4.0');
    await expect(page.locator('[data-testid="lrud-down-2-0"]')).toHaveText('-');

    // Second shot: left=0, right=1.8, up=0, down=3.2
    await expect(page.locator('[data-testid="lrud-left-2-1"]')).toHaveText('-');
    await expect(page.locator('[data-testid="lrud-right-2-1"]')).toHaveText('1.8');
    await expect(page.locator('[data-testid="lrud-up-2-1"]')).toHaveText('-');
    await expect(page.locator('[data-testid="lrud-down-2-1"]')).toHaveText('3.2');
  });

  test('large LRUD values displayed correctly', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    // Expand third section (Mixed LRUD Section)
    const expandButton = page.locator('[data-testid="section-expand-2"]');
    await expandButton.click();

    // Third shot has large LRUD values: left=10.5, right=15.2, up=20.0, down=8.5
    await expect(page.locator('[data-testid="lrud-left-2-2"]')).toHaveText('10.5');
    await expect(page.locator('[data-testid="lrud-right-2-2"]')).toHaveText('15.2');
    await expect(page.locator('[data-testid="lrud-up-2-2"]')).toHaveText('20.0');
    await expect(page.locator('[data-testid="lrud-down-2-2"]')).toHaveText('8.5');
  });

  test('multiple sections can be expanded simultaneously', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    // Expand first section
    const expandButton0 = page.locator('[data-testid="section-expand-0"]');
    await expandButton0.click();
    await expect(page.locator('[data-testid="shot-row-0-0"]')).toBeVisible();

    // Expand second section as well
    const expandButton1 = page.locator('[data-testid="section-expand-1"]');
    await expandButton1.click();
    await expect(page.locator('[data-testid="shot-row-1-0"]')).toBeVisible();

    // Both should still be expanded
    await expect(expandButton0).toHaveText('▼');
    await expect(expandButton1).toHaveText('▼');
    await expect(page.locator('[data-testid="shot-row-0-0"]')).toBeVisible();
    await expect(page.locator('[data-testid="shot-row-1-0"]')).toBeVisible();
  });

  test('undefined LRUD shows as dash', async ({ page }) => {
    // Per epic spec fn-4-qe3: "Show '-' for zero/null LRUD values (indicates 'not measured')"
    // Both zero and undefined/null should render as "-" - this is intentional design
    // to indicate the measurement was not taken, regardless of explicit 0 vs missing field
    await createProjectAndOpenImportDialog(page);

    // Expand "Undefined LRUD Section" (index 3) which has shots with missing LRUD fields
    const expandButton = page.locator('[data-testid="section-expand-3"]');
    await expandButton.click();

    // First shot has all LRUD fields undefined - should show "-" for all
    await expect(page.locator('[data-testid="lrud-left-3-0"]')).toHaveText('-');
    await expect(page.locator('[data-testid="lrud-right-3-0"]')).toHaveText('-');
    await expect(page.locator('[data-testid="lrud-up-3-0"]')).toHaveText('-');
    await expect(page.locator('[data-testid="lrud-down-3-0"]')).toHaveText('-');

    // Second shot has partial LRUD: left=1.2, up=2.5, right and down undefined
    await expect(page.locator('[data-testid="lrud-left-3-1"]')).toHaveText('1.2');
    await expect(page.locator('[data-testid="lrud-right-3-1"]')).toHaveText('-');
    await expect(page.locator('[data-testid="lrud-up-3-1"]')).toHaveText('2.5');
    await expect(page.locator('[data-testid="lrud-down-3-1"]')).toHaveText('-');
  });

  test('empty section has no expand button', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    // Empty Section (index 4) should not have an expand button
    // Use toHaveCount(0) since the element should not be rendered at all
    const expandButton = page.locator('[data-testid="section-expand-4"]');
    await expect(expandButton).toHaveCount(0);

    // Verify the section row still shows the name
    await expect(page.locator('text=Empty Section')).toBeVisible();
  });

  test('collapsing section hides shot rows', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    // Expand first section
    const expandButton = page.locator('[data-testid="section-expand-0"]');
    await expandButton.click();

    // Shot rows visible
    const shotRow = page.locator('[data-testid="shot-row-0-0"]');
    await expect(shotRow).toBeVisible();

    // Collapse section
    await expandButton.click();

    // Shot rows should be hidden
    await expect(shotRow).toHaveCount(0);
    await expect(expandButton).toHaveText('▶');
  });
});

test.describe('Pitch Column', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('pitch column visible in shot preview', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    // Expand first section
    const expandButton = page.locator('[data-testid="section-expand-0"]');
    await expandButton.click();

    // Verify Pitch column header is visible
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog.locator('th', { hasText: /^Pitch$/ })).toBeVisible();

    // Verify pitch cells exist with data-testid
    await expect(page.locator('[data-testid="pitch-0-0"]')).toBeVisible();
  });

  test('pitch average calculation - both values present', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    // Expand first section (Main Passage)
    const expandButton = page.locator('[data-testid="section-expand-0"]');
    await expandButton.click();

    // Second shot has pitch_in: 5, pitch_out: 5 => average = 5.0
    await expect(page.locator('[data-testid="pitch-0-1"]')).toHaveText('5.0');

    // Third shot has pitch_in: -10, pitch_out: -10 => average = -10.0
    await expect(page.locator('[data-testid="pitch-0-2"]')).toHaveText('-10.0');
  });

  test('pitch single value shown when only one present', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    // Expand "Mixed LRUD Section" (index 2) which has varied pitch values
    const expandButton = page.locator('[data-testid="section-expand-2"]');
    await expandButton.click();

    // First shot: pitch_in: 8.0, pitch_out: 0 => shows 8.0 (only pitch_in)
    await expect(page.locator('[data-testid="pitch-2-0"]')).toHaveText('8.0');

    // Second shot: pitch_in: 0, pitch_out: 12.0 => shows 12.0 (only pitch_out)
    await expect(page.locator('[data-testid="pitch-2-1"]')).toHaveText('12.0');

    // Third shot: pitch_in: 6.0, pitch_out: 10.0 => average = 8.0
    await expect(page.locator('[data-testid="pitch-2-2"]')).toHaveText('8.0');
  });

  test('pitch shows dash for zero values', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    // Expand first section (Main Passage)
    const expandButton = page.locator('[data-testid="section-expand-0"]');
    await expandButton.click();

    // First shot has pitch_in: 0, pitch_out: 0 => shows "-"
    await expect(page.locator('[data-testid="pitch-0-0"]')).toHaveText('-');
  });

  test('pitch shows dash for zero/unmeasured values in different section', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    // Expand "Undefined LRUD Section" (index 3) which has zero pitch values
    const expandButton = page.locator('[data-testid="section-expand-3"]');
    await expandButton.click();

    // Shots have pitch_in: 0, pitch_out: 0 => shows "-" (zero means "not measured" in DMP)
    await expect(page.locator('[data-testid="pitch-3-0"]')).toHaveText('-');
    await expect(page.locator('[data-testid="pitch-3-1"]')).toHaveText('-');
  });

  test('pitch data-testid follows expected format', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    // Expand first section
    const expandButton = page.locator('[data-testid="section-expand-0"]');
    await expandButton.click();

    // Verify data-testid format: pitch-{sectionIndex}-{shotIndex}
    await expect(page.locator('[data-testid="pitch-0-0"]')).toBeVisible();
    await expect(page.locator('[data-testid="pitch-0-1"]')).toBeVisible();
    await expect(page.locator('[data-testid="pitch-0-2"]')).toBeVisible();
  });
});

test.describe('Comment Column', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('comment column visible in shot preview', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    // Expand first section
    const expandButton = page.locator('[data-testid="section-expand-0"]');
    await expandButton.click();

    // Verify Comment column header is visible
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog.locator('th', { hasText: /^Comment$/ })).toBeVisible();

    // Verify comment cells exist with data-testid
    await expect(page.locator('[data-testid="comment-0-0"]')).toBeVisible();
    await expect(page.locator('[data-testid="comment-0-1"]')).toBeVisible();
    await expect(page.locator('[data-testid="comment-0-2"]')).toBeVisible();
  });

  test('short comment displays in full', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    // Expand first section (Main Passage)
    const expandButton = page.locator('[data-testid="section-expand-0"]');
    await expandButton.click();

    // First shot has short comment: "Entrance point with good visibility" (36 chars < 50)
    const commentCell = page.locator('[data-testid="comment-0-0"]');
    await expect(commentCell).toContainText('Entrance point with good visibility');

    // No expand button should be present for short comments
    const expandCommentBtn = page.locator('[data-testid="comment-expand-0-0"]');
    await expect(expandCommentBtn).toHaveCount(0);
  });

  test('long comment truncated at 50 chars with expand button', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    // Expand first section (Main Passage)
    const expandButton = page.locator('[data-testid="section-expand-0"]');
    await expandButton.click();

    // Third shot has long comment (81 chars): "Large chamber with stalactites on ceiling, white formations visible on right wall"
    const commentCell = page.locator('[data-testid="comment-0-2"]');

    // Should show truncated text with "..."
    await expect(commentCell).toContainText('Large chamber with stalactites on ceiling, white');
    await expect(commentCell).toContainText('...');

    // Expand button should be visible
    const expandCommentBtn = page.locator('[data-testid="comment-expand-0-2"]');
    await expect(expandCommentBtn).toBeVisible();
    await expect(expandCommentBtn).toHaveText('▶');
  });

  test('click expands and collapses long comment', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    // Expand first section (Main Passage)
    const expandButton = page.locator('[data-testid="section-expand-0"]');
    await expandButton.click();

    const commentCell = page.locator('[data-testid="comment-0-2"]');
    const expandCommentBtn = page.locator('[data-testid="comment-expand-0-2"]');

    // Initially collapsed
    await expect(expandCommentBtn).toHaveText('▶');
    await expect(commentCell).not.toContainText('right wall');

    // Click to expand
    await expandCommentBtn.click();

    // Now expanded - shows full text and down arrow
    await expect(expandCommentBtn).toHaveText('▼');
    await expect(commentCell).toContainText('right wall');

    // Click to collapse again
    await expandCommentBtn.click();

    // Back to collapsed state
    await expect(expandCommentBtn).toHaveText('▶');
    await expect(commentCell).not.toContainText('right wall');
  });

  test('keyboard accessible - Enter and Space to toggle when focused', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    // Expand first section (Main Passage)
    const expandButton = page.locator('[data-testid="section-expand-0"]');
    await expandButton.click();

    const expandCommentBtn = page.locator('[data-testid="comment-expand-0-2"]');

    // Focus the expand button (simulating Tab navigation to the button)
    await expandCommentBtn.focus();
    await expect(expandCommentBtn).toBeFocused();

    // Initially collapsed
    await expect(expandCommentBtn).toHaveText('▶');

    // Press Enter to expand (native button behavior)
    await page.keyboard.press('Enter');
    await expect(expandCommentBtn).toHaveText('▼');

    // Press Space to collapse (native button behavior)
    await page.keyboard.press('Space');
    await expect(expandCommentBtn).toHaveText('▶');
  });

  test('aria-expanded attribute present and correct', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    // Expand first section (Main Passage)
    const expandButton = page.locator('[data-testid="section-expand-0"]');
    await expandButton.click();

    const expandCommentBtn = page.locator('[data-testid="comment-expand-0-2"]');

    // Initially collapsed - aria-expanded should be false
    await expect(expandCommentBtn).toHaveAttribute('aria-expanded', 'false');

    // Click to expand
    await expandCommentBtn.click();

    // Now expanded - aria-expanded should be true
    await expect(expandCommentBtn).toHaveAttribute('aria-expanded', 'true');
  });

  test('empty cell for no comment', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    // Expand first section (Main Passage)
    const expandButton = page.locator('[data-testid="section-expand-0"]');
    await expandButton.click();

    // Second shot has no comment (undefined)
    const commentCell = page.locator('[data-testid="comment-0-1"]');
    await expect(commentCell).toHaveText('-');

    // No expand button for empty comment
    const expandCommentBtn = page.locator('[data-testid="comment-expand-0-1"]');
    await expect(expandCommentBtn).toHaveCount(0);
  });

  test('comment data-testid follows expected format', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    // Expand first section
    const expandButton = page.locator('[data-testid="section-expand-0"]');
    await expandButton.click();

    // Verify data-testid format: comment-{sectionIndex}-{shotIndex}
    await expect(page.locator('[data-testid="comment-0-0"]')).toBeVisible();
    await expect(page.locator('[data-testid="comment-0-1"]')).toBeVisible();
    await expect(page.locator('[data-testid="comment-0-2"]')).toBeVisible();
  });

  test('short comment in different section displays correctly', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    // Expand second section (Side Tunnel)
    const expandButton = page.locator('[data-testid="section-expand-1"]');
    await expandButton.click();

    // First shot has comment: "Narrow restriction" (18 chars < 50)
    const commentCell = page.locator('[data-testid="comment-1-0"]');
    await expect(commentCell).toContainText('Narrow restriction');

    // No expand button for short comment
    const expandCommentBtn = page.locator('[data-testid="comment-expand-1-0"]');
    await expect(expandCommentBtn).toHaveCount(0);
  });
});

test.describe('Statistics Footer', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('stats footer visible below section table', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    // Stats footer should be visible
    const statsFooter = page.locator('[data-testid="stats-footer"]');
    await expect(statsFooter).toBeVisible();

    // Verify all stat elements exist
    await expect(page.locator('[data-testid="stats-total-length"]')).toBeVisible();
    await expect(page.locator('[data-testid="stats-shot-count"]')).toBeVisible();
    await expect(page.locator('[data-testid="stats-depth-range"]')).toBeVisible();
  });

  test('stats calculated correctly for all selected sections', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    // By default, sections with shots are selected (Main Passage, Side Tunnel, Mixed LRUD, Undefined LRUD)
    // Total length: 33.7 + 12.5 + 71.5 + 14.0 = 131.7m
    // Shot count: 3 + 2 + 3 + 2 = 10
    // Depth range: -1.0 to -8.0 (from all sections)
    // Use polling expectations instead of waitForTimeout to avoid flaky tests
    const totalLength = page.locator('[data-testid="stats-total-length"]');
    await expect(totalLength).toContainText('131.7m', { timeout: 2000 });

    const shotCount = page.locator('[data-testid="stats-shot-count"]');
    await expect(shotCount).toContainText('10', { timeout: 2000 });

    const depthRange = page.locator('[data-testid="stats-depth-range"]');
    await expect(depthRange).toContainText('-8.0m to -1.0m', { timeout: 2000 });
  });

  test('stats update when selection changes', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    // Wait for initial stats to be calculated (poll for non-zero value)
    const totalLength = page.locator('[data-testid="stats-total-length"]');
    await expect(totalLength).toContainText('131.7m', { timeout: 2000 });

    // Click "None" to deselect all (scoped to import dialog)
    const dialog = page.locator('[role="dialog"]');
    await dialog.locator('button:has-text("None")').click();

    // Stats should show zero/placeholder values (poll instead of waitForTimeout)
    await expect(totalLength).toContainText('0.0m', { timeout: 2000 });

    const shotCount = page.locator('[data-testid="stats-shot-count"]');
    await expect(shotCount).toContainText('0', { timeout: 2000 });

    const depthRange = page.locator('[data-testid="stats-depth-range"]');
    await expect(depthRange).toContainText('--', { timeout: 2000 });
  });

  test('stats for single section selection', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    // Deselect all first (scoped to import dialog)
    const dialog = page.locator('[role="dialog"]');
    await dialog.locator('button:has-text("None")').click();

    // Wait for stats to show zero (poll instead of waitForTimeout)
    const totalLength = page.locator('[data-testid="stats-total-length"]');
    await expect(totalLength).toContainText('0.0m', { timeout: 2000 });

    // Select only Main Passage (first section)
    // Find the checkbox for the first section (Main Passage)
    const mainPassageRow = page.locator('tr').filter({ hasText: 'Main Passage' });
    await mainPassageRow.locator('input[type="checkbox"]').click();

    // Main Passage: 3 shots, lengths 10.5 + 15.2 + 8.0 = 33.7m
    // Depths: -2.0, -2.5, -5.0, -3.0 => min -5.0, max -2.0
    // Poll for expected values instead of waitForTimeout
    await expect(totalLength).toContainText('33.7m', { timeout: 2000 });

    const shotCount = page.locator('[data-testid="stats-shot-count"]');
    await expect(shotCount).toContainText('3', { timeout: 2000 });

    const depthRange = page.locator('[data-testid="stats-depth-range"]');
    await expect(depthRange).toContainText('-5.0m to -2.0m', { timeout: 2000 });
  });

  test('text is selectable in stats footer', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    // The stats footer should have select-text class
    const statsFooter = page.locator('[data-testid="stats-footer"]');
    await expect(statsFooter).toHaveClass(/select-text/);
  });

  test('stats show placeholder for no selection', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    // Click "None" to deselect all sections (scoped to import dialog)
    const dialog = page.locator('[role="dialog"]');
    await dialog.locator('button:has-text("None")').click();

    // Verify placeholder values (poll instead of waitForTimeout)
    const totalLength = page.locator('[data-testid="stats-total-length"]');
    await expect(totalLength).toHaveText('Total: 0.0m', { timeout: 2000 });

    const shotCount = page.locator('[data-testid="stats-shot-count"]');
    await expect(shotCount).toHaveText('Shots: 0', { timeout: 2000 });

    const depthRange = page.locator('[data-testid="stats-depth-range"]');
    await expect(depthRange).toContainText('--', { timeout: 2000 });
  });

  test('stats format depth range correctly', async ({ page }) => {
    await createProjectAndOpenImportDialog(page);

    // Depth range should show in format "Xm to Ym" (poll for expected value)
    const depthRange = page.locator('[data-testid="stats-depth-range"]');
    await expect(depthRange).toContainText('-8.0m to -1.0m', { timeout: 2000 });

    // Verify the format
    const text = await depthRange.textContent();

    // Should contain "Depth:" label
    expect(text).toContain('Depth:');

    // When there's data, should show min to max format
    expect(text).toMatch(/-?\d+\.\d+m to -?\d+\.\d+m/);
  });
});
