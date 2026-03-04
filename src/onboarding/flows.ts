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

export const ONBOARDING_FLOWS: readonly OnboardingFlowDefinition[] = [
  globalEmptyFlow,
  singleViewFlow,
];
