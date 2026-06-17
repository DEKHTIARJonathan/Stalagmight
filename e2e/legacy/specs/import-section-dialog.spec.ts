import {
  waitForAppReady,
  resetAppState,
  createNewProject,
  openImportSectionDialog,
} from '../helpers/app';

describe('Import Section Dialog', () => {
  beforeEach(async () => {
    // Wait for the app to be fully loaded
    await waitForAppReady();
    // Reset any leftover state from previous tests
    await resetAppState();
  });

  it('should open import section dialog via store and display it', async () => {
    // Create a new project
    await createNewProject('Test Project');

    // Open Import Section Dialog via store
    await openImportSectionDialog();

    // Verify Import Section Dialog is displayed using data-testid
    const importDialog = await $('[data-testid="import-section-dialog"]');
    await expect(importDialog).toBeDisplayed();

    // Look for "Import" or "Section" text in dialog
    const dialogContent = await importDialog.getText();
    expect(dialogContent.toLowerCase()).toContain('section');

    // Close the dialog using Cancel button
    const cancelBtn = await importDialog.$('button*=Cancel');
    await cancelBtn.click();

    // Verify dialog closed
    await importDialog.waitForDisplayed({ reverse: true, timeout: 5000 });
  });

  it('should display section name input field', async () => {
    await createNewProject('Section Name Test');
    await openImportSectionDialog();

    // Find section name input using data-testid
    const sectionNameInput = await $('[data-testid="section-name-input"]');
    await expect(sectionNameInput).toBeExisting();

    // Enter a section name
    await sectionNameInput.setValue('Main Passage');

    // Verify the value was entered
    const value = await sectionNameInput.getValue();
    expect(value).toBe('Main Passage');

    // Close the dialog using Cancel button
    const importDialog = await $('[data-testid="import-section-dialog"]');
    const cancelBtn = await importDialog.$('button*=Cancel');
    await cancelBtn.click();
    await importDialog.waitForDisplayed({ reverse: true, timeout: 5000 });
  });

  it('should display surveyor and date fields', async () => {
    await createNewProject('Fields Test Project');
    await openImportSectionDialog();

    const importDialog = await $('[data-testid="import-section-dialog"]');

    // Look for surveyor input
    const surveyorLabel = await importDialog.$('label*=Surveyor');
    await expect(surveyorLabel).toBeExisting();

    // Look for date input
    const dateLabel = await importDialog.$('label*=Date');
    await expect(dateLabel).toBeExisting();

    // Look for color input
    const colorLabel = await importDialog.$('label*=Color');
    await expect(colorLabel).toBeExisting();

    // Close the dialog using Cancel button
    const cancelBtn = await importDialog.$('button*=Cancel');
    await cancelBtn.click();
    await importDialog.waitForDisplayed({ reverse: true, timeout: 5000 });
  });

  it('should have Create Section and Cancel buttons', async () => {
    await createNewProject('Buttons Test');
    await openImportSectionDialog();

    const importDialog = await $('[data-testid="import-section-dialog"]');

    // Find Create Section button
    const importBtn = await importDialog.$('button*=Create Section');
    await expect(importBtn).toBeExisting();

    // Find Cancel button
    const cancelBtn = await importDialog.$('button*=Cancel');
    await expect(cancelBtn).toBeExisting();

    // Close using Cancel
    await cancelBtn.click();
    await importDialog.waitForDisplayed({ reverse: true, timeout: 5000 });
  });
});
