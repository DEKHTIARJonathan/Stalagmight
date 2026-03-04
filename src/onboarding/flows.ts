import type { ViewType } from '../store/uiStore';

export type OnboardingPlacement = 'top' | 'bottom' | 'left' | 'right' | 'center';
export type OnboardingInteraction = 'locked' | 'target' | 'free';

export interface OnboardingStepDefinition {
  id: string;
  titleKey: string;
  descriptionKey: string;
  targetSelector?: string;
  targetSelectors?: string[];
  placement?: OnboardingPlacement;
  interaction?: OnboardingInteraction;
}

export interface OnboardingContext {
  view: ViewType;
  hasProject: boolean;
  hasRecentProjects: boolean;
  configRecentProjectsCount: number | null;
  activeDialog: string | null;
  isDmpImportContext: boolean;
  loadingProject: boolean;
  splashVisible: boolean;
  configLoaded: boolean;
}

export interface OnboardingFlowDefinition {
  id: string;
  titleKey: string;
  shouldStart: (context: OnboardingContext) => boolean;
  steps: OnboardingStepDefinition[];
}

const canShowOnboarding = (context: OnboardingContext): boolean =>
  context.configLoaded &&
  !context.splashVisible &&
  !context.loadingProject &&
  context.activeDialog === null;

const canShowDialogOnboarding = (context: OnboardingContext): boolean =>
  context.configLoaded &&
  !context.splashVisible &&
  !context.loadingProject;

const globalEmptyFlow: OnboardingFlowDefinition = {
  id: 'global-empty-basics',
  titleKey: 'onboarding.flows.globalEmpty.title',
  shouldStart: (context) =>
    canShowOnboarding(context) &&
    context.view === 'global' &&
    !context.hasProject &&
    !context.hasRecentProjects &&
    context.configRecentProjectsCount === 0,
  steps: [
    {
      id: 'welcome',
      titleKey: 'onboarding.flows.globalEmpty.steps.welcome.title',
      descriptionKey: 'onboarding.flows.globalEmpty.steps.welcome.description',
      placement: 'center',
      interaction: 'locked',
    },
    {
      id: 'import',
      titleKey: 'onboarding.flows.globalEmpty.steps.import.title',
      descriptionKey: 'onboarding.flows.globalEmpty.steps.import.description',
      targetSelectors: [
        '[data-testid="empty-state-import-dmp"]',
        '[data-testid="global-import-dmp-button"]',
      ],
      placement: 'bottom',
      interaction: 'locked',
    },
    {
      id: 'new-project',
      titleKey: 'onboarding.flows.globalEmpty.steps.newProject.title',
      descriptionKey: 'onboarding.flows.globalEmpty.steps.newProject.description',
      targetSelectors: [
        '[data-testid="empty-state-new-project"]',
        '[data-testid="new-project-button"]',
      ],
      placement: 'bottom',
      interaction: 'locked',
    },
    {
      id: 'open-project',
      titleKey: 'onboarding.flows.globalEmpty.steps.openProject.title',
      descriptionKey: 'onboarding.flows.globalEmpty.steps.openProject.description',
      targetSelectors: [
        '[data-testid="empty-state-open-project"]',
        '[data-testid="global-open-project-button"]',
      ],
      placement: 'bottom',
      interaction: 'locked',
    },
    {
      id: 'settings',
      titleKey: 'onboarding.flows.globalEmpty.steps.settings.title',
      descriptionKey: 'onboarding.flows.globalEmpty.steps.settings.description',
      targetSelector: '[data-testid="settings-button"]',
      placement: 'bottom',
      interaction: 'locked',
    },
    {
      id: 'debug-logs',
      titleKey: 'onboarding.flows.globalEmpty.steps.debugLogs.title',
      descriptionKey: 'onboarding.flows.globalEmpty.steps.debugLogs.description',
      targetSelector: '[data-testid="global-debug-button"]',
      placement: 'bottom',
      interaction: 'locked',
    },
  ],
};

const singleViewFlow: OnboardingFlowDefinition = {
  id: 'single-view-basics',
  titleKey: 'onboarding.flows.singleView.title',
  shouldStart: (context) =>
    canShowOnboarding(context) &&
    context.view === 'single' &&
    context.hasProject,
  steps: [
    {
      id: 'toolbar',
      titleKey: 'onboarding.flows.singleView.steps.toolbar.title',
      descriptionKey: 'onboarding.flows.singleView.steps.toolbar.description',
      targetSelector: '[data-testid="toolbar"]',
      placement: 'bottom',
      interaction: 'locked',
    },
    {
      id: 'draw-tool',
      titleKey: 'onboarding.flows.singleView.steps.drawTool.title',
      descriptionKey: 'onboarding.flows.singleView.steps.drawTool.description',
      targetSelector: '[data-testid="tool-draw"]',
      placement: 'bottom',
      interaction: 'locked',
    },
    {
      id: 'map',
      titleKey: 'onboarding.flows.singleView.steps.map.title',
      descriptionKey: 'onboarding.flows.singleView.steps.map.description',
      targetSelector: '[data-testid="map-canvas"]',
      placement: 'top',
      interaction: 'locked',
    },
    {
      id: 'detail-panel',
      titleKey: 'onboarding.flows.singleView.steps.detailPanel.title',
      descriptionKey: 'onboarding.flows.singleView.steps.detailPanel.description',
      targetSelector: '[data-testid="detail-panel"]',
      placement: 'left',
      interaction: 'locked',
    },
  ],
};

const dmpNewProjectFlow: OnboardingFlowDefinition = {
  id: 'dmp-new-project',
  titleKey: 'onboarding.flows.dmpNewProject.title',
  shouldStart: (context) =>
    canShowDialogOnboarding(context) &&
    context.activeDialog === 'new-project-for-import' &&
    context.isDmpImportContext,
  steps: [
    {
      id: 'dialog',
      titleKey: 'onboarding.flows.dmpNewProject.steps.dialog.title',
      descriptionKey: 'onboarding.flows.dmpNewProject.steps.dialog.description',
      targetSelector: '[data-testid="new-project-for-import-dialog"]',
      placement: 'center',
      interaction: 'locked',
    },
    {
      id: 'project-name',
      titleKey: 'onboarding.flows.dmpNewProject.steps.projectName.title',
      descriptionKey: 'onboarding.flows.dmpNewProject.steps.projectName.description',
      targetSelectors: [
        '[data-testid="project-name-input"]',
        '[data-testid="project-save-path-controls"]',
      ],
      placement: 'bottom',
      interaction: 'locked',
    },
    {
      id: 'create-and-continue',
      titleKey: 'onboarding.flows.dmpNewProject.steps.createAndContinue.title',
      descriptionKey: 'onboarding.flows.dmpNewProject.steps.createAndContinue.description',
      targetSelector: '[data-testid="create-and-continue-button"]',
      placement: 'top',
      interaction: 'locked',
    },
  ],
};

const dmpSelectionFlow: OnboardingFlowDefinition = {
  id: 'dmp-selection',
  titleKey: 'onboarding.flows.dmpSelection.title',
  shouldStart: (context) =>
    canShowDialogOnboarding(context) &&
    context.activeDialog === 'dmp-selection',
  steps: [
    {
      id: 'dialog',
      titleKey: 'onboarding.flows.dmpSelection.steps.dialog.title',
      descriptionKey: 'onboarding.flows.dmpSelection.steps.dialog.description',
      targetSelector: '[data-testid="dmp-selection-dialog"]',
      placement: 'center',
      interaction: 'locked',
    },
    {
      id: 'file-overview',
      titleKey: 'onboarding.flows.dmpSelection.steps.fileOverview.title',
      descriptionKey: 'onboarding.flows.dmpSelection.steps.fileOverview.description',
      targetSelectors: [
        '[data-testid="dmp-filename"]',
        '[data-testid="selection-stats"]',
      ],
      placement: 'bottom',
      interaction: 'locked',
    },
    {
      id: 'default-values',
      titleKey: 'onboarding.flows.dmpSelection.steps.defaultValues.title',
      descriptionKey: 'onboarding.flows.dmpSelection.steps.defaultValues.description',
      targetSelectors: [
        '[data-testid="default-surveyor-input"]',
        '[data-testid="default-date-input"]',
      ],
      placement: 'bottom',
      interaction: 'locked',
    },
    {
      id: 'bulk-selection',
      titleKey: 'onboarding.flows.dmpSelection.steps.bulkSelection.title',
      descriptionKey: 'onboarding.flows.dmpSelection.steps.bulkSelection.description',
      targetSelectors: [
        '[data-testid="select-all-button"]',
        '[data-testid="select-none-button"]',
        '[data-testid="invert-selection-button"]',
      ],
      placement: 'bottom',
      interaction: 'locked',
    },
    {
      id: 'continue',
      titleKey: 'onboarding.flows.dmpSelection.steps.continue.title',
      descriptionKey: 'onboarding.flows.dmpSelection.steps.continue.description',
      targetSelector: '[data-testid="continue-button"]',
      placement: 'top',
      interaction: 'locked',
    },
  ],
};

const zeroDatumSelectionFlow: OnboardingFlowDefinition = {
  id: 'zero-datum-selection',
  titleKey: 'onboarding.flows.zeroDatumSelection.title',
  shouldStart: (context) =>
    canShowDialogOnboarding(context) &&
    context.activeDialog === 'zero-datum-selection',
  steps: [
    {
      id: 'dialog',
      titleKey: 'onboarding.flows.zeroDatumSelection.steps.dialog.title',
      descriptionKey: 'onboarding.flows.zeroDatumSelection.steps.dialog.description',
      targetSelector: '[data-testid="zero-datum-selection-dialog"]',
      placement: 'center',
      interaction: 'locked',
    },
    {
      id: 'choose-section',
      titleKey: 'onboarding.flows.zeroDatumSelection.steps.chooseSection.title',
      descriptionKey: 'onboarding.flows.zeroDatumSelection.steps.chooseSection.description',
      targetSelector: '[data-testid^="zero-datum-section-card-"]',
      placement: 'top',
      interaction: 'locked',
    },
    {
      id: 'navigation',
      titleKey: 'onboarding.flows.zeroDatumSelection.steps.navigation.title',
      descriptionKey: 'onboarding.flows.zeroDatumSelection.steps.navigation.description',
      targetSelectors: [
        '[data-testid="zero-datum-selection-cancel"]',
        '[data-testid="zero-datum-selection-back"]',
      ],
      placement: 'top',
      interaction: 'locked',
    },
  ],
};

const zeroDatumConfigFlow: OnboardingFlowDefinition = {
  id: 'zero-datum-config',
  titleKey: 'onboarding.flows.zeroDatumConfig.title',
  shouldStart: (context) =>
    canShowDialogOnboarding(context) &&
    context.activeDialog === 'zero-datum-config',
  steps: [
    {
      id: 'dialog',
      titleKey: 'onboarding.flows.zeroDatumConfig.steps.dialog.title',
      descriptionKey: 'onboarding.flows.zeroDatumConfig.steps.dialog.description',
      targetSelector: '[data-testid="zero-datum-config-dialog"]',
      placement: 'center',
      interaction: 'locked',
    },
    {
      id: 'station',
      titleKey: 'onboarding.flows.zeroDatumConfig.steps.station.title',
      descriptionKey: 'onboarding.flows.zeroDatumConfig.steps.station.description',
      targetSelector: '[data-testid="zero-datum-station-select"]',
      placement: 'bottom',
      interaction: 'locked',
    },
    {
      id: 'gps',
      titleKey: 'onboarding.flows.zeroDatumConfig.steps.gps.title',
      descriptionKey: 'onboarding.flows.zeroDatumConfig.steps.gps.description',
      targetSelector: '[data-testid="zero-datum-gps-input"]',
      placement: 'bottom',
      interaction: 'locked',
    },
    {
      id: 'confirm',
      titleKey: 'onboarding.flows.zeroDatumConfig.steps.confirm.title',
      descriptionKey: 'onboarding.flows.zeroDatumConfig.steps.confirm.description',
      targetSelector: '[data-testid="zero-datum-config-confirm"]',
      placement: 'top',
      interaction: 'locked',
    },
  ],
};

const dmpWizardFlow: OnboardingFlowDefinition = {
  id: 'dmp-new-import',
  titleKey: 'onboarding.flows.dmpNewImport.title',
  shouldStart: (context) =>
    canShowDialogOnboarding(context) &&
    context.activeDialog === 'dmp-import-new',
  steps: [
    {
      id: 'dialog',
      titleKey: 'onboarding.flows.dmpNewImport.steps.dialog.title',
      descriptionKey: 'onboarding.flows.dmpNewImport.steps.dialog.description',
      targetSelector: '[data-testid="dmp-new-import-dialog"]',
      placement: 'center',
      interaction: 'locked',
    },
    {
      id: 'progress',
      titleKey: 'onboarding.flows.dmpNewImport.steps.progress.title',
      descriptionKey: 'onboarding.flows.dmpNewImport.steps.progress.description',
      targetSelector: '[data-testid="wizard-progress"]',
      placement: 'bottom',
      interaction: 'locked',
    },
    {
      id: 'placement-panel',
      titleKey: 'onboarding.flows.dmpNewImport.steps.placementPanel.title',
      descriptionKey: 'onboarding.flows.dmpNewImport.steps.placementPanel.description',
      targetSelectors: [
        '[data-testid="wizard-suggestion"]',
        '[data-testid="wizard-manual-placing"]',
      ],
      placement: 'left',
      interaction: 'locked',
    },
    {
      id: 'actions',
      titleKey: 'onboarding.flows.dmpNewImport.steps.actions.title',
      descriptionKey: 'onboarding.flows.dmpNewImport.steps.actions.description',
      targetSelectors: [
        '[data-testid="confirm-button"]',
        '[data-testid="skip-button"]',
        '[data-testid="segment-place-button"]',
        '[data-testid="segment-skip-button"]',
        '[data-testid="segment-place-on-map-button"]',
        '[data-testid="retry-button"]',
      ],
      placement: 'top',
      interaction: 'locked',
    },
  ],
};

const dmpLegacyConfigFlow: OnboardingFlowDefinition = {
  id: 'dmp-section-config',
  titleKey: 'onboarding.flows.dmpLegacyConfig.title',
  shouldStart: (context) =>
    canShowDialogOnboarding(context) &&
    context.activeDialog === 'dmp-section-config',
  steps: [
    {
      id: 'dialog',
      titleKey: 'onboarding.flows.dmpLegacyConfig.steps.dialog.title',
      descriptionKey: 'onboarding.flows.dmpLegacyConfig.steps.dialog.description',
      targetSelector: '[data-testid="dmp-section-config-dialog"]',
      placement: 'center',
      interaction: 'locked',
    },
    {
      id: 'section-list',
      titleKey: 'onboarding.flows.dmpLegacyConfig.steps.sectionList.title',
      descriptionKey: 'onboarding.flows.dmpLegacyConfig.steps.sectionList.description',
      targetSelector: '[data-testid="section-list-panel"]',
      placement: 'right',
      interaction: 'locked',
    },
    {
      id: 'placement',
      titleKey: 'onboarding.flows.dmpLegacyConfig.steps.placement.title',
      descriptionKey: 'onboarding.flows.dmpLegacyConfig.steps.placement.description',
      targetSelector: '[data-testid="placement-panel"]',
      placement: 'left',
      interaction: 'locked',
    },
    {
      id: 'actions',
      titleKey: 'onboarding.flows.dmpLegacyConfig.steps.actions.title',
      descriptionKey: 'onboarding.flows.dmpLegacyConfig.steps.actions.description',
      targetSelectors: [
        '[data-testid="place-section-button"]',
        '[data-testid="place-and-finish-button"]',
        '[data-testid="next-section-button"]',
        '[data-testid="finish-import-button"]',
        '[data-testid="exclude-button"]',
        '[data-testid="include-button"]',
      ],
      placement: 'top',
      interaction: 'locked',
    },
  ],
};

export const ONBOARDING_FLOWS: readonly OnboardingFlowDefinition[] = [
  globalEmptyFlow,
  singleViewFlow,
  dmpNewProjectFlow,
  dmpSelectionFlow,
  zeroDatumSelectionFlow,
  zeroDatumConfigFlow,
  dmpWizardFlow,
  dmpLegacyConfigFlow,
];
