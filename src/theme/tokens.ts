export const themeTokens = {
  dark: {
    // UI Chrome
    '--cc-background': '#1a1a2e',
    '--cc-panel': '#16213e',
    '--cc-border': '#0f3460',
    '--cc-text-primary': '#f5f5f5',
    '--cc-text-secondary': '#a0a0a0',
    '--cc-accent': '#4ecdc4',
    '--cc-accent-on': '#1a1a2e',
    '--cc-warning': '#ffcb77',
    '--cc-error': '#ff6b6b',
    '--cc-success': '#95e1d3',
    '--cc-hover': '#1a1a2e',
    '--cc-focus-ring': '#4ecdc4',
    '--cc-focus-glow': 'rgba(78, 205, 196, 0.5)',
    '--cc-scrollbar-track': '#16213e',
    '--cc-scrollbar-thumb': '#0f3460',
    '--cc-scrollbar-hover': '#4ecdc4',
    '--cc-input-bg': '#16213e',
    '--cc-input-border': '#0f3460',
    '--cc-outside-month': '#666666',
    '--cc-selection-gradient': 'rgba(78, 205, 196, 0.3)',
    '--cc-overlay': 'rgba(0, 0, 0, 0.5)',

    // MapLibre Controls
    '--cc-map-ctrl-bg': '#16213e',
    '--cc-map-ctrl-border': '#0f3460',
    '--cc-map-ctrl-hover': '#1a1a2e',
    '--cc-map-ctrl-active': '#0f3460',
    '--cc-map-ctrl-icon-filter': 'brightness(0) invert(1)',
    '--cc-map-ctrl-shadow': 'rgba(15, 52, 96, 0.3)',
    '--cc-map-scale-bg': 'transparent',
    '--cc-map-scale-border': '#0f3460',
    '--cc-map-scale-text': '#f5f5f5',

    // Map Visualization (dark only)
    '--cc-map-background': '#1a1a2e',
    '--cc-snap-color': '#ff6b6b',
    '--cc-hover-highlight': '#ffcb77',
    '--cc-select-highlight': '#4ecdc4',
    '--cc-stroke-color': '#ffffff',
    '--cc-stroke-light': 'rgba(255, 255, 255, 0.25)',
    '--cc-text-halo': '#1a1a2e',
    '--cc-text-halo-alt': 'rgba(0, 0, 0, 0.7)',
    '--cc-station-default': '#a0a0a0',
    '--cc-gray-line': '#666666',
    '--cc-gray-text': '#999999',
    '--cc-grid-default': '#333366',
    '--cc-zero-datum': '#ffd700',
    '--cc-compass-color': '#ffffff',
    '--cc-depth-shallow': '#4ecdc4',
    '--cc-depth-deep': '#ff6b6b',
    '--cc-depth-text': '#f5f5f5',

    // Canvas Preview (dark only)
    '--cc-preview-bg': '#1a1a2e',
    '--cc-preview-text': '#f5f5f5',

    // Opacity Variants: accent
    '--cc-accent-5': 'rgba(78, 205, 196, 0.05)',
    '--cc-accent-10': 'rgba(78, 205, 196, 0.1)',
    '--cc-accent-20': 'rgba(78, 205, 196, 0.2)',
    '--cc-accent-30': 'rgba(78, 205, 196, 0.3)',
    '--cc-accent-50': 'rgba(78, 205, 196, 0.5)',
    '--cc-accent-70': 'rgba(78, 205, 196, 0.7)',
    '--cc-accent-80': 'rgba(78, 205, 196, 0.8)',
    '--cc-accent-90': 'rgba(78, 205, 196, 0.9)',

    // Opacity Variants: background
    '--cc-background-30': 'rgba(26, 26, 46, 0.3)',
    '--cc-background-50': 'rgba(26, 26, 46, 0.5)',
    '--cc-background-80': 'rgba(26, 26, 46, 0.8)',

    // Opacity Variants: panel
    '--cc-panel-20': 'rgba(22, 33, 62, 0.2)',
    '--cc-panel-50': 'rgba(22, 33, 62, 0.5)',
    '--cc-panel-90': 'rgba(22, 33, 62, 0.9)',

    // Opacity Variants: error
    '--cc-error-10': 'rgba(255, 107, 107, 0.1)',
    '--cc-error-20': 'rgba(255, 107, 107, 0.2)',
    '--cc-error-30': 'rgba(255, 107, 107, 0.3)',
    '--cc-error-80': 'rgba(255, 107, 107, 0.8)',
    '--cc-error-90': 'rgba(255, 107, 107, 0.9)',

    // Opacity Variants: warning
    '--cc-warning-5': 'rgba(255, 203, 119, 0.05)',
    '--cc-warning-10': 'rgba(255, 203, 119, 0.1)',
    '--cc-warning-20': 'rgba(255, 203, 119, 0.2)',
    '--cc-warning-30': 'rgba(255, 203, 119, 0.3)',

    // Opacity Variants: success
    '--cc-success-5': 'rgba(149, 225, 211, 0.05)',
    '--cc-success-10': 'rgba(149, 225, 211, 0.1)',
    '--cc-success-30': 'rgba(149, 225, 211, 0.3)',
  },
  light: {
    // UI Chrome
    '--cc-background': '#f5f0e8',
    '--cc-panel': '#ffffff',
    '--cc-border': '#d4c5a9',
    '--cc-text-primary': '#1a120b',
    '--cc-text-secondary': '#6b5b4a',
    '--cc-accent': '#3a8a82',
    '--cc-accent-on': '#ffffff',
    '--cc-warning': '#b8860b',
    '--cc-error': '#c0392b',
    '--cc-success': '#27764e',
    '--cc-hover': '#ede6db',
    '--cc-focus-ring': '#3a8a82',
    '--cc-focus-glow': 'rgba(58, 138, 130, 0.4)',
    '--cc-scrollbar-track': '#ede6db',
    '--cc-scrollbar-thumb': '#c1a07a',
    '--cc-scrollbar-hover': '#3a8a82',
    '--cc-input-bg': '#ffffff',
    '--cc-input-border': '#d4c5a9',
    '--cc-outside-month': '#b0a090',
    '--cc-selection-gradient': 'rgba(58, 138, 130, 0.2)',
    '--cc-overlay': 'rgba(0, 0, 0, 0.5)',

    // MapLibre Controls
    '--cc-map-ctrl-bg': '#ffffff',
    '--cc-map-ctrl-border': '#d4c5a9',
    '--cc-map-ctrl-hover': '#ede6db',
    '--cc-map-ctrl-active': '#d4c5a9',
    '--cc-map-ctrl-icon-filter': 'none',
    '--cc-map-ctrl-shadow': 'rgba(0, 0, 0, 0.15)',
    '--cc-map-scale-bg': 'transparent',
    '--cc-map-scale-border': '#d4c5a9',
    '--cc-map-scale-text': '#1a120b',

    // Opacity Variants: accent
    '--cc-accent-5': 'rgba(58, 138, 130, 0.05)',
    '--cc-accent-10': 'rgba(58, 138, 130, 0.1)',
    '--cc-accent-20': 'rgba(58, 138, 130, 0.2)',
    '--cc-accent-30': 'rgba(58, 138, 130, 0.3)',
    '--cc-accent-50': 'rgba(58, 138, 130, 0.5)',
    '--cc-accent-70': 'rgba(58, 138, 130, 0.7)',
    '--cc-accent-80': 'rgba(58, 138, 130, 0.8)',
    '--cc-accent-90': 'rgba(58, 138, 130, 0.9)',

    // Opacity Variants: background
    '--cc-background-30': 'rgba(245, 240, 232, 0.3)',
    '--cc-background-50': 'rgba(245, 240, 232, 0.5)',
    '--cc-background-80': 'rgba(245, 240, 232, 0.8)',

    // Opacity Variants: panel
    '--cc-panel-20': 'rgba(255, 255, 255, 0.2)',
    '--cc-panel-50': 'rgba(255, 255, 255, 0.5)',
    '--cc-panel-90': 'rgba(255, 255, 255, 0.9)',

    // Opacity Variants: error
    '--cc-error-10': 'rgba(192, 57, 43, 0.1)',
    '--cc-error-20': 'rgba(192, 57, 43, 0.2)',
    '--cc-error-30': 'rgba(192, 57, 43, 0.3)',
    '--cc-error-80': 'rgba(192, 57, 43, 0.8)',
    '--cc-error-90': 'rgba(192, 57, 43, 0.9)',

    // Opacity Variants: warning
    '--cc-warning-5': 'rgba(184, 134, 11, 0.05)',
    '--cc-warning-10': 'rgba(184, 134, 11, 0.1)',
    '--cc-warning-20': 'rgba(184, 134, 11, 0.2)',
    '--cc-warning-30': 'rgba(184, 134, 11, 0.3)',

    // Opacity Variants: success
    '--cc-success-5': 'rgba(39, 118, 78, 0.05)',
    '--cc-success-10': 'rgba(39, 118, 78, 0.1)',
    '--cc-success-30': 'rgba(39, 118, 78, 0.3)',
  },
} as const;

// Map visuals stay dark; these tokens must not be overridden in light theme.
export const darkOnlyTokenNames = [
  '--cc-map-background',
  '--cc-snap-color',
  '--cc-hover-highlight',
  '--cc-select-highlight',
  '--cc-stroke-color',
  '--cc-stroke-light',
  '--cc-text-halo',
  '--cc-text-halo-alt',
  '--cc-station-default',
  '--cc-gray-line',
  '--cc-gray-text',
  '--cc-grid-default',
  '--cc-zero-datum',
  '--cc-compass-color',
  '--cc-depth-shallow',
  '--cc-depth-deep',
  '--cc-depth-text',
  '--cc-preview-bg',
  '--cc-preview-text',
] as const;

export type ThemeTokenName = keyof typeof themeTokens.dark;
