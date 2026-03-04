import type { DmpImportWizardPhase, ViewType } from '../store/uiStore';

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
  tooltipOffsetX?: number;
  tooltipOffsetY?: number;
  tooltipAnchorY?: 'auto' | 'top' | 'bottom';
  tooltipTargetSelector?: string;
  scrollContainerSelector?: string;
  scrollTargetSelector?: string;
  scrollAlignment?: 'top' | 'nearest';
}

export interface OnboardingContext {
  view: ViewType;
  hasProject: boolean;
  hasRecentProjects: boolean;
  configRecentProjectsCount: number | null;
  activeDialog: string | null;
  dmpImportWizardPhase: DmpImportWizardPhase | null;
  placementModeActive: boolean;
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
  !context.placementModeActive &&
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
      targetSelector: '[data-testid="dmp-file-overview"]',
      placement: 'bottom',
      interaction: 'locked',
    },
    {
      id: 'default-values',
      titleKey: 'onboarding.flows.dmpSelection.steps.defaultValues.title',
      descriptionKey: 'onboarding.flows.dmpSelection.steps.defaultValues.description',
      targetSelector: '[data-testid="dmp-default-values"]',
      placement: 'bottom',
      interaction: 'locked',
    },
    {
      id: 'section-table',
      titleKey: 'onboarding.flows.dmpSelection.steps.sectionTable.title',
      descriptionKey: 'onboarding.flows.dmpSelection.steps.sectionTable.description',
      targetSelector: '[data-testid="dmp-section-table"]',
      placement: 'top',
      interaction: 'locked',
    },
    {
      id: 'bulk-selection',
      titleKey: 'onboarding.flows.dmpSelection.steps.bulkSelection.title',
      descriptionKey: 'onboarding.flows.dmpSelection.steps.bulkSelection.description',
      targetSelector: '[data-testid="dmp-bulk-selection-controls"]',
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
      scrollContainerSelector: '[data-testid="dmp-selection-dialog"]',
      scrollTargetSelector: '[data-testid="continue-button"]',
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
      targetSelector: '[data-testid="zero-datum-selection-skip"]',
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
      targetSelectors: [
        '[data-testid="zero-datum-station-select"]',
        '[data-testid="zero-datum-preview-map"]',
      ],
      placement: 'bottom',
      interaction: 'locked',
      tooltipAnchorY: 'bottom',
      tooltipTargetSelector: '[data-testid="zero-datum-station-select"]',
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
      id: 'section-name',
      titleKey: 'onboarding.flows.zeroDatumConfig.steps.sectionName.title',
      descriptionKey: 'onboarding.flows.zeroDatumConfig.steps.sectionName.description',
      targetSelector: '[data-testid="section-name-input"]',
      placement: 'bottom',
      interaction: 'locked',
    },
    {
      id: 'other-data',
      titleKey: 'onboarding.flows.zeroDatumConfig.steps.otherData.title',
      descriptionKey: 'onboarding.flows.zeroDatumConfig.steps.otherData.description',
      targetSelector: '[data-testid="zero-datum-editable-rest"]',
      placement: 'bottom',
      interaction: 'locked',
      scrollContainerSelector: '[data-testid="zero-datum-config-right-pane"]',
      scrollTargetSelector: '[data-testid="zero-datum-editable-rest"]',
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

const dmpSuggestedConnectionFlow: OnboardingFlowDefinition = {
  id: 'dmp-suggested-connection',
  titleKey: 'onboarding.flows.dmpSuggestedConnection.title',
  shouldStart: (context) =>
    canShowDialogOnboarding(context) &&
    context.activeDialog === 'dmp-import-new' &&
    context.dmpImportWizardPhase === 'suggesting',
  steps: [
    {
      id: 'dialog',
      titleKey: 'onboarding.flows.dmpSuggestedConnection.steps.dialog.title',
      descriptionKey: 'onboarding.flows.dmpSuggestedConnection.steps.dialog.description',
      targetSelector: '[data-testid="dmp-new-import-dialog"]',
      placement: 'center',
      interaction: 'locked',
    },
    {
      id: 'connection',
      titleKey: 'onboarding.flows.dmpSuggestedConnection.steps.connection.title',
      descriptionKey: 'onboarding.flows.dmpSuggestedConnection.steps.connection.description',
      targetSelector: '[data-testid="wizard-connection-description"]',
      placement: 'bottom',
      interaction: 'locked',
    },
    {
      id: 'confidence',
      titleKey: 'onboarding.flows.dmpSuggestedConnection.steps.confidence.title',
      descriptionKey: 'onboarding.flows.dmpSuggestedConnection.steps.confidence.description',
      targetSelectors: [
        '[data-testid="wizard-confidence"]',
        '[data-testid="toggle-alternatives"]',
      ],
      placement: 'bottom',
      interaction: 'locked',
    },
    {
      id: 'merge-station',
      titleKey: 'onboarding.flows.dmpSuggestedConnection.steps.mergeStation.title',
      descriptionKey: 'onboarding.flows.dmpSuggestedConnection.steps.mergeStation.description',
      targetSelector: '[data-testid="wizard-merge-station-control"]',
      placement: 'bottom',
      interaction: 'locked',
    },
    {
      id: 'overlap',
      titleKey: 'onboarding.flows.dmpSuggestedConnection.steps.overlap.title',
      descriptionKey: 'onboarding.flows.dmpSuggestedConnection.steps.overlap.description',
      targetSelector: '[data-testid="wizard-overlap-control"]',
      placement: 'bottom',
      interaction: 'locked',
    },
    {
      id: 'section-name',
      titleKey: 'onboarding.flows.dmpSuggestedConnection.steps.sectionName.title',
      descriptionKey: 'onboarding.flows.dmpSuggestedConnection.steps.sectionName.description',
      targetSelector: '[data-testid="section-name-input"]',
      placement: 'bottom',
      interaction: 'locked',
      scrollContainerSelector: '[data-testid="wizard-suggestion"]',
      scrollTargetSelector: '[data-testid="section-name-input"]',
      scrollAlignment: 'nearest',
    },
    {
      id: 'other-data',
      titleKey: 'onboarding.flows.dmpSuggestedConnection.steps.otherData.title',
      descriptionKey: 'onboarding.flows.dmpSuggestedConnection.steps.otherData.description',
      targetSelector: '[data-testid="wizard-editable-rest"]',
      placement: 'bottom',
      interaction: 'locked',
      scrollContainerSelector: '[data-testid="wizard-suggestion"]',
      scrollTargetSelector: '[data-testid="wizard-editable-rest"]',
    },
    {
      id: 'actions',
      titleKey: 'onboarding.flows.dmpSuggestedConnection.steps.actions.title',
      descriptionKey: 'onboarding.flows.dmpSuggestedConnection.steps.actions.description',
      targetSelector: '[data-testid="wizard-suggestion-actions"]',
      placement: 'top',
      interaction: 'locked',
    },
  ],
};

const dmpSegmentPlacementFlow: OnboardingFlowDefinition = {
  id: 'dmp-segment-placement',
  titleKey: 'onboarding.flows.dmpSegmentPlacement.title',
  shouldStart: (context) =>
    canShowDialogOnboarding(context) &&
    context.activeDialog === 'dmp-import-new' &&
    context.dmpImportWizardPhase === 'manual_placing',
  steps: [
    {
      id: 'segment-panel',
      titleKey: 'onboarding.flows.dmpSegmentPlacement.steps.segmentPanel.title',
      descriptionKey: 'onboarding.flows.dmpSegmentPlacement.steps.segmentPanel.description',
      targetSelector: '[data-testid="wizard-manual-placing"]',
      placement: 'left',
      interaction: 'locked',
    },
    {
      id: 'placement-modes',
      titleKey: 'onboarding.flows.dmpSegmentPlacement.steps.placementModes.title',
      descriptionKey: 'onboarding.flows.dmpSegmentPlacement.steps.placementModes.description',
      targetSelector: '[data-testid="segment-placement-modes"]',
      placement: 'left',
      interaction: 'locked',
    },
    {
      id: 'actions',
      titleKey: 'onboarding.flows.dmpSegmentPlacement.steps.actions.title',
      descriptionKey: 'onboarding.flows.dmpSegmentPlacement.steps.actions.description',
      targetSelectors: [
        '[data-testid="segment-place-button"]',
        '[data-testid="segment-skip-button"]',
        '[data-testid="segment-place-on-map-button"]',
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
  dmpSuggestedConnectionFlow,
  dmpSegmentPlacementFlow,
  dmpLegacyConfigFlow,
];
