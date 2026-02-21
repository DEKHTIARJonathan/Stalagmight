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
  cave: {
    // UI Chrome — very dark, desaturated, faint warm tint
    '--cc-background': '#0e0d0c',
    '--cc-panel': '#171615',
    '--cc-border': '#2a2826',
    '--cc-text-primary': '#d5d0ca',
    '--cc-text-secondary': '#858280',
    '--cc-accent': '#a89060',
    '--cc-accent-on': '#0e0d0c',
    '--cc-warning': '#b89848',
    '--cc-error': '#b85048',
    '--cc-success': '#48986a',
    '--cc-hover': '#171615',
    '--cc-focus-ring': '#a89060',
    '--cc-focus-glow': 'rgba(168, 144, 96, 0.35)',
    '--cc-scrollbar-track': '#171615',
    '--cc-scrollbar-thumb': '#2a2826',
    '--cc-scrollbar-hover': '#a89060',
    '--cc-input-bg': '#171615',
    '--cc-input-border': '#2a2826',
    '--cc-outside-month': '#585654',
    '--cc-selection-gradient': 'rgba(168, 144, 96, 0.2)',
    '--cc-overlay': 'rgba(0, 0, 0, 0.5)',

    // MapLibre Controls
    '--cc-map-ctrl-bg': '#171615',
    '--cc-map-ctrl-border': '#2a2826',
    '--cc-map-ctrl-hover': '#0e0d0c',
    '--cc-map-ctrl-active': '#2a2826',
    '--cc-map-ctrl-icon-filter': 'brightness(0) invert(1)',
    '--cc-map-ctrl-shadow': 'rgba(42, 40, 38, 0.3)',
    '--cc-map-scale-bg': 'transparent',
    '--cc-map-scale-border': '#2a2826',
    '--cc-map-scale-text': '#d5d0ca',

    // Map Visualization
    '--cc-map-background': '#0e0d0c',
    '--cc-snap-color': '#b85048',
    '--cc-hover-highlight': '#b89848',
    '--cc-select-highlight': '#a89060',
    '--cc-stroke-color': '#d5d0ca',
    '--cc-stroke-light': 'rgba(213, 208, 202, 0.25)',
    '--cc-text-halo': '#0e0d0c',
    '--cc-text-halo-alt': 'rgba(0, 0, 0, 0.7)',
    '--cc-station-default': '#858280',
    '--cc-gray-line': '#585654',
    '--cc-gray-text': '#787674',
    '--cc-grid-default': '#2a2826',
    '--cc-zero-datum': '#b8a868',
    '--cc-compass-color': '#d5d0ca',
    '--cc-depth-shallow': '#a89060',
    '--cc-depth-deep': '#b85048',
    '--cc-depth-text': '#d5d0ca',

    // Canvas Preview
    '--cc-preview-bg': '#0e0d0c',
    '--cc-preview-text': '#d5d0ca',

    // Opacity Variants: accent
    '--cc-accent-5': 'rgba(168, 144, 96, 0.05)',
    '--cc-accent-10': 'rgba(168, 144, 96, 0.1)',
    '--cc-accent-20': 'rgba(168, 144, 96, 0.2)',
    '--cc-accent-30': 'rgba(168, 144, 96, 0.3)',
    '--cc-accent-50': 'rgba(168, 144, 96, 0.5)',
    '--cc-accent-70': 'rgba(168, 144, 96, 0.7)',
    '--cc-accent-80': 'rgba(168, 144, 96, 0.8)',
    '--cc-accent-90': 'rgba(168, 144, 96, 0.9)',

    // Opacity Variants: background
    '--cc-background-30': 'rgba(14, 13, 12, 0.3)',
    '--cc-background-50': 'rgba(14, 13, 12, 0.5)',
    '--cc-background-80': 'rgba(14, 13, 12, 0.8)',

    // Opacity Variants: panel
    '--cc-panel-20': 'rgba(23, 22, 21, 0.2)',
    '--cc-panel-50': 'rgba(23, 22, 21, 0.5)',
    '--cc-panel-90': 'rgba(23, 22, 21, 0.9)',

    // Opacity Variants: error
    '--cc-error-10': 'rgba(184, 80, 72, 0.1)',
    '--cc-error-20': 'rgba(184, 80, 72, 0.2)',
    '--cc-error-30': 'rgba(184, 80, 72, 0.3)',
    '--cc-error-80': 'rgba(184, 80, 72, 0.8)',
    '--cc-error-90': 'rgba(184, 80, 72, 0.9)',

    // Opacity Variants: warning
    '--cc-warning-5': 'rgba(184, 152, 72, 0.05)',
    '--cc-warning-10': 'rgba(184, 152, 72, 0.1)',
    '--cc-warning-20': 'rgba(184, 152, 72, 0.2)',
    '--cc-warning-30': 'rgba(184, 152, 72, 0.3)',

    // Opacity Variants: success
    '--cc-success-5': 'rgba(72, 152, 106, 0.05)',
    '--cc-success-10': 'rgba(72, 152, 106, 0.1)',
    '--cc-success-30': 'rgba(72, 152, 106, 0.3)',
  },
  dracula: {
    // UI Chrome
    '--cc-background': '#282a36',
    '--cc-panel': '#21222c',
    '--cc-border': '#44475a',
    '--cc-text-primary': '#f8f8f2',
    '--cc-text-secondary': '#6272a4',
    '--cc-accent': '#bd93f9',
    '--cc-accent-on': '#282a36',
    '--cc-warning': '#ffb86c',
    '--cc-error': '#ff5555',
    '--cc-success': '#50fa7b',
    '--cc-hover': '#282a36',
    '--cc-focus-ring': '#bd93f9',
    '--cc-focus-glow': 'rgba(189, 147, 249, 0.5)',
    '--cc-scrollbar-track': '#21222c',
    '--cc-scrollbar-thumb': '#44475a',
    '--cc-scrollbar-hover': '#bd93f9',
    '--cc-input-bg': '#21222c',
    '--cc-input-border': '#44475a',
    '--cc-outside-month': '#6272a4',
    '--cc-selection-gradient': 'rgba(189, 147, 249, 0.3)',
    '--cc-overlay': 'rgba(0, 0, 0, 0.5)',

    // MapLibre Controls
    '--cc-map-ctrl-bg': '#21222c',
    '--cc-map-ctrl-border': '#44475a',
    '--cc-map-ctrl-hover': '#282a36',
    '--cc-map-ctrl-active': '#44475a',
    '--cc-map-ctrl-icon-filter': 'brightness(0) invert(1)',
    '--cc-map-ctrl-shadow': 'rgba(68, 71, 90, 0.3)',
    '--cc-map-scale-bg': 'transparent',
    '--cc-map-scale-border': '#44475a',
    '--cc-map-scale-text': '#f8f8f2',

    // Map Visualization
    '--cc-map-background': '#282a36',
    '--cc-snap-color': '#ff5555',
    '--cc-hover-highlight': '#ffb86c',
    '--cc-select-highlight': '#bd93f9',
    '--cc-stroke-color': '#f8f8f2',
    '--cc-stroke-light': 'rgba(248, 248, 242, 0.25)',
    '--cc-text-halo': '#282a36',
    '--cc-text-halo-alt': 'rgba(0, 0, 0, 0.7)',
    '--cc-station-default': '#6272a4',
    '--cc-gray-line': '#44475a',
    '--cc-gray-text': '#6272a4',
    '--cc-grid-default': '#44475a',
    '--cc-zero-datum': '#f1fa8c',
    '--cc-compass-color': '#f8f8f2',
    '--cc-depth-shallow': '#8be9fd',
    '--cc-depth-deep': '#ff5555',
    '--cc-depth-text': '#f8f8f2',

    // Canvas Preview
    '--cc-preview-bg': '#282a36',
    '--cc-preview-text': '#f8f8f2',

    // Opacity Variants: accent
    '--cc-accent-5': 'rgba(189, 147, 249, 0.05)',
    '--cc-accent-10': 'rgba(189, 147, 249, 0.1)',
    '--cc-accent-20': 'rgba(189, 147, 249, 0.2)',
    '--cc-accent-30': 'rgba(189, 147, 249, 0.3)',
    '--cc-accent-50': 'rgba(189, 147, 249, 0.5)',
    '--cc-accent-70': 'rgba(189, 147, 249, 0.7)',
    '--cc-accent-80': 'rgba(189, 147, 249, 0.8)',
    '--cc-accent-90': 'rgba(189, 147, 249, 0.9)',

    // Opacity Variants: background
    '--cc-background-30': 'rgba(40, 42, 54, 0.3)',
    '--cc-background-50': 'rgba(40, 42, 54, 0.5)',
    '--cc-background-80': 'rgba(40, 42, 54, 0.8)',

    // Opacity Variants: panel
    '--cc-panel-20': 'rgba(33, 34, 44, 0.2)',
    '--cc-panel-50': 'rgba(33, 34, 44, 0.5)',
    '--cc-panel-90': 'rgba(33, 34, 44, 0.9)',

    // Opacity Variants: error
    '--cc-error-10': 'rgba(255, 85, 85, 0.1)',
    '--cc-error-20': 'rgba(255, 85, 85, 0.2)',
    '--cc-error-30': 'rgba(255, 85, 85, 0.3)',
    '--cc-error-80': 'rgba(255, 85, 85, 0.8)',
    '--cc-error-90': 'rgba(255, 85, 85, 0.9)',

    // Opacity Variants: warning
    '--cc-warning-5': 'rgba(255, 184, 108, 0.05)',
    '--cc-warning-10': 'rgba(255, 184, 108, 0.1)',
    '--cc-warning-20': 'rgba(255, 184, 108, 0.2)',
    '--cc-warning-30': 'rgba(255, 184, 108, 0.3)',

    // Opacity Variants: success
    '--cc-success-5': 'rgba(80, 250, 123, 0.05)',
    '--cc-success-10': 'rgba(80, 250, 123, 0.1)',
    '--cc-success-30': 'rgba(80, 250, 123, 0.3)',
  },
  one_dark: {
    // UI Chrome
    '--cc-background': '#282c34',
    '--cc-panel': '#21252b',
    '--cc-border': '#3e4451',
    '--cc-text-primary': '#abb2bf',
    '--cc-text-secondary': '#5c6370',
    '--cc-accent': '#61afef',
    '--cc-accent-on': '#282c34',
    '--cc-warning': '#e5c07b',
    '--cc-error': '#e06c75',
    '--cc-success': '#98c379',
    '--cc-hover': '#2c313a',
    '--cc-focus-ring': '#61afef',
    '--cc-focus-glow': 'rgba(97, 175, 239, 0.5)',
    '--cc-scrollbar-track': '#21252b',
    '--cc-scrollbar-thumb': '#3e4451',
    '--cc-scrollbar-hover': '#61afef',
    '--cc-input-bg': '#21252b',
    '--cc-input-border': '#3e4451',
    '--cc-outside-month': '#5c6370',
    '--cc-selection-gradient': 'rgba(97, 175, 239, 0.3)',
    '--cc-overlay': 'rgba(0, 0, 0, 0.5)',

    // MapLibre Controls
    '--cc-map-ctrl-bg': '#21252b',
    '--cc-map-ctrl-border': '#3e4451',
    '--cc-map-ctrl-hover': '#282c34',
    '--cc-map-ctrl-active': '#3e4451',
    '--cc-map-ctrl-icon-filter': 'brightness(0) invert(1)',
    '--cc-map-ctrl-shadow': 'rgba(62, 68, 81, 0.3)',
    '--cc-map-scale-bg': 'transparent',
    '--cc-map-scale-border': '#3e4451',
    '--cc-map-scale-text': '#abb2bf',

    // Map Visualization
    '--cc-map-background': '#282c34',
    '--cc-snap-color': '#e06c75',
    '--cc-hover-highlight': '#e5c07b',
    '--cc-select-highlight': '#61afef',
    '--cc-stroke-color': '#abb2bf',
    '--cc-stroke-light': 'rgba(171, 178, 191, 0.25)',
    '--cc-text-halo': '#282c34',
    '--cc-text-halo-alt': 'rgba(0, 0, 0, 0.7)',
    '--cc-station-default': '#5c6370',
    '--cc-gray-line': '#3e4451',
    '--cc-gray-text': '#5c6370',
    '--cc-grid-default': '#3e4451',
    '--cc-zero-datum': '#e5c07b',
    '--cc-compass-color': '#abb2bf',
    '--cc-depth-shallow': '#56b6c2',
    '--cc-depth-deep': '#e06c75',
    '--cc-depth-text': '#abb2bf',

    // Canvas Preview
    '--cc-preview-bg': '#282c34',
    '--cc-preview-text': '#abb2bf',

    // Opacity Variants: accent
    '--cc-accent-5': 'rgba(97, 175, 239, 0.05)',
    '--cc-accent-10': 'rgba(97, 175, 239, 0.1)',
    '--cc-accent-20': 'rgba(97, 175, 239, 0.2)',
    '--cc-accent-30': 'rgba(97, 175, 239, 0.3)',
    '--cc-accent-50': 'rgba(97, 175, 239, 0.5)',
    '--cc-accent-70': 'rgba(97, 175, 239, 0.7)',
    '--cc-accent-80': 'rgba(97, 175, 239, 0.8)',
    '--cc-accent-90': 'rgba(97, 175, 239, 0.9)',

    // Opacity Variants: background
    '--cc-background-30': 'rgba(40, 44, 52, 0.3)',
    '--cc-background-50': 'rgba(40, 44, 52, 0.5)',
    '--cc-background-80': 'rgba(40, 44, 52, 0.8)',

    // Opacity Variants: panel
    '--cc-panel-20': 'rgba(33, 37, 43, 0.2)',
    '--cc-panel-50': 'rgba(33, 37, 43, 0.5)',
    '--cc-panel-90': 'rgba(33, 37, 43, 0.9)',

    // Opacity Variants: error
    '--cc-error-10': 'rgba(224, 108, 117, 0.1)',
    '--cc-error-20': 'rgba(224, 108, 117, 0.2)',
    '--cc-error-30': 'rgba(224, 108, 117, 0.3)',
    '--cc-error-80': 'rgba(224, 108, 117, 0.8)',
    '--cc-error-90': 'rgba(224, 108, 117, 0.9)',

    // Opacity Variants: warning
    '--cc-warning-5': 'rgba(229, 192, 123, 0.05)',
    '--cc-warning-10': 'rgba(229, 192, 123, 0.1)',
    '--cc-warning-20': 'rgba(229, 192, 123, 0.2)',
    '--cc-warning-30': 'rgba(229, 192, 123, 0.3)',

    // Opacity Variants: success
    '--cc-success-5': 'rgba(152, 195, 121, 0.05)',
    '--cc-success-10': 'rgba(152, 195, 121, 0.1)',
    '--cc-success-30': 'rgba(152, 195, 121, 0.3)',
  },
  solarized_light: {
    // UI Chrome
    '--cc-background': '#fdf6e3',
    '--cc-panel': '#eee8d5',
    '--cc-border': '#d3cbb7',
    '--cc-text-primary': '#586e75',
    '--cc-text-secondary': '#93a1a1',
    '--cc-accent': '#268bd2',
    '--cc-accent-on': '#fdf6e3',
    '--cc-warning': '#b58900',
    '--cc-error': '#dc322f',
    '--cc-success': '#859900',
    '--cc-hover': '#eee8d5',
    '--cc-focus-ring': '#268bd2',
    '--cc-focus-glow': 'rgba(38, 139, 210, 0.4)',
    '--cc-scrollbar-track': '#eee8d5',
    '--cc-scrollbar-thumb': '#d3cbb7',
    '--cc-scrollbar-hover': '#268bd2',
    '--cc-input-bg': '#fdf6e3',
    '--cc-input-border': '#d3cbb7',
    '--cc-outside-month': '#93a1a1',
    '--cc-selection-gradient': 'rgba(38, 139, 210, 0.2)',
    '--cc-overlay': 'rgba(0, 0, 0, 0.5)',

    // MapLibre Controls
    '--cc-map-ctrl-bg': '#eee8d5',
    '--cc-map-ctrl-border': '#d3cbb7',
    '--cc-map-ctrl-hover': '#fdf6e3',
    '--cc-map-ctrl-active': '#d3cbb7',
    '--cc-map-ctrl-icon-filter': 'none',
    '--cc-map-ctrl-shadow': 'rgba(0, 0, 0, 0.15)',
    '--cc-map-scale-bg': 'transparent',
    '--cc-map-scale-border': '#d3cbb7',
    '--cc-map-scale-text': '#586e75',

    // Opacity Variants: accent
    '--cc-accent-5': 'rgba(38, 139, 210, 0.05)',
    '--cc-accent-10': 'rgba(38, 139, 210, 0.1)',
    '--cc-accent-20': 'rgba(38, 139, 210, 0.2)',
    '--cc-accent-30': 'rgba(38, 139, 210, 0.3)',
    '--cc-accent-50': 'rgba(38, 139, 210, 0.5)',
    '--cc-accent-70': 'rgba(38, 139, 210, 0.7)',
    '--cc-accent-80': 'rgba(38, 139, 210, 0.8)',
    '--cc-accent-90': 'rgba(38, 139, 210, 0.9)',

    // Opacity Variants: background
    '--cc-background-30': 'rgba(253, 246, 227, 0.3)',
    '--cc-background-50': 'rgba(253, 246, 227, 0.5)',
    '--cc-background-80': 'rgba(253, 246, 227, 0.8)',

    // Opacity Variants: panel
    '--cc-panel-20': 'rgba(238, 232, 213, 0.2)',
    '--cc-panel-50': 'rgba(238, 232, 213, 0.5)',
    '--cc-panel-90': 'rgba(238, 232, 213, 0.9)',

    // Opacity Variants: error
    '--cc-error-10': 'rgba(220, 50, 47, 0.1)',
    '--cc-error-20': 'rgba(220, 50, 47, 0.2)',
    '--cc-error-30': 'rgba(220, 50, 47, 0.3)',
    '--cc-error-80': 'rgba(220, 50, 47, 0.8)',
    '--cc-error-90': 'rgba(220, 50, 47, 0.9)',

    // Opacity Variants: warning
    '--cc-warning-5': 'rgba(181, 137, 0, 0.05)',
    '--cc-warning-10': 'rgba(181, 137, 0, 0.1)',
    '--cc-warning-20': 'rgba(181, 137, 0, 0.2)',
    '--cc-warning-30': 'rgba(181, 137, 0, 0.3)',

    // Opacity Variants: success
    '--cc-success-5': 'rgba(133, 153, 0, 0.05)',
    '--cc-success-10': 'rgba(133, 153, 0, 0.1)',
    '--cc-success-30': 'rgba(133, 153, 0, 0.3)',
  },
  catppuccin_latte: {
    // UI Chrome
    '--cc-background': '#eff1f5',
    '--cc-panel': '#e6e9ef',
    '--cc-border': '#ccd0da',
    '--cc-text-primary': '#4c4f69',
    '--cc-text-secondary': '#6c6f85',
    '--cc-accent': '#1e66f5',
    '--cc-accent-on': '#eff1f5',
    '--cc-warning': '#df8e1d',
    '--cc-error': '#d20f39',
    '--cc-success': '#40a02b',
    '--cc-hover': '#e6e9ef',
    '--cc-focus-ring': '#1e66f5',
    '--cc-focus-glow': 'rgba(30, 102, 245, 0.4)',
    '--cc-scrollbar-track': '#e6e9ef',
    '--cc-scrollbar-thumb': '#ccd0da',
    '--cc-scrollbar-hover': '#1e66f5',
    '--cc-input-bg': '#e6e9ef',
    '--cc-input-border': '#ccd0da',
    '--cc-outside-month': '#9ca0b0',
    '--cc-selection-gradient': 'rgba(30, 102, 245, 0.2)',
    '--cc-overlay': 'rgba(0, 0, 0, 0.5)',

    // MapLibre Controls
    '--cc-map-ctrl-bg': '#e6e9ef',
    '--cc-map-ctrl-border': '#ccd0da',
    '--cc-map-ctrl-hover': '#eff1f5',
    '--cc-map-ctrl-active': '#ccd0da',
    '--cc-map-ctrl-icon-filter': 'none',
    '--cc-map-ctrl-shadow': 'rgba(0, 0, 0, 0.15)',
    '--cc-map-scale-bg': 'transparent',
    '--cc-map-scale-border': '#ccd0da',
    '--cc-map-scale-text': '#4c4f69',

    // Opacity Variants: accent
    '--cc-accent-5': 'rgba(30, 102, 245, 0.05)',
    '--cc-accent-10': 'rgba(30, 102, 245, 0.1)',
    '--cc-accent-20': 'rgba(30, 102, 245, 0.2)',
    '--cc-accent-30': 'rgba(30, 102, 245, 0.3)',
    '--cc-accent-50': 'rgba(30, 102, 245, 0.5)',
    '--cc-accent-70': 'rgba(30, 102, 245, 0.7)',
    '--cc-accent-80': 'rgba(30, 102, 245, 0.8)',
    '--cc-accent-90': 'rgba(30, 102, 245, 0.9)',

    // Opacity Variants: background
    '--cc-background-30': 'rgba(239, 241, 245, 0.3)',
    '--cc-background-50': 'rgba(239, 241, 245, 0.5)',
    '--cc-background-80': 'rgba(239, 241, 245, 0.8)',

    // Opacity Variants: panel
    '--cc-panel-20': 'rgba(230, 233, 239, 0.2)',
    '--cc-panel-50': 'rgba(230, 233, 239, 0.5)',
    '--cc-panel-90': 'rgba(230, 233, 239, 0.9)',

    // Opacity Variants: error
    '--cc-error-10': 'rgba(210, 15, 57, 0.1)',
    '--cc-error-20': 'rgba(210, 15, 57, 0.2)',
    '--cc-error-30': 'rgba(210, 15, 57, 0.3)',
    '--cc-error-80': 'rgba(210, 15, 57, 0.8)',
    '--cc-error-90': 'rgba(210, 15, 57, 0.9)',

    // Opacity Variants: warning
    '--cc-warning-5': 'rgba(223, 142, 29, 0.05)',
    '--cc-warning-10': 'rgba(223, 142, 29, 0.1)',
    '--cc-warning-20': 'rgba(223, 142, 29, 0.2)',
    '--cc-warning-30': 'rgba(223, 142, 29, 0.3)',

    // Opacity Variants: success
    '--cc-success-5': 'rgba(64, 160, 43, 0.05)',
    '--cc-success-10': 'rgba(64, 160, 43, 0.1)',
    '--cc-success-30': 'rgba(64, 160, 43, 0.3)',
  },
  nord: {
    // UI Chrome
    '--cc-background': '#2e3440',
    '--cc-panel': '#3b4252',
    '--cc-border': '#4c566a',
    '--cc-text-primary': '#d8dee9',
    '--cc-text-secondary': '#616e88',
    '--cc-accent': '#88c0d0',
    '--cc-accent-on': '#2e3440',
    '--cc-warning': '#ebcb8b',
    '--cc-error': '#bf616a',
    '--cc-success': '#a3be8c',
    '--cc-hover': '#3b4252',
    '--cc-focus-ring': '#88c0d0',
    '--cc-focus-glow': 'rgba(136, 192, 208, 0.5)',
    '--cc-scrollbar-track': '#3b4252',
    '--cc-scrollbar-thumb': '#4c566a',
    '--cc-scrollbar-hover': '#88c0d0',
    '--cc-input-bg': '#3b4252',
    '--cc-input-border': '#4c566a',
    '--cc-outside-month': '#616e88',
    '--cc-selection-gradient': 'rgba(136, 192, 208, 0.3)',
    '--cc-overlay': 'rgba(0, 0, 0, 0.5)',

    // MapLibre Controls
    '--cc-map-ctrl-bg': '#3b4252',
    '--cc-map-ctrl-border': '#4c566a',
    '--cc-map-ctrl-hover': '#2e3440',
    '--cc-map-ctrl-active': '#4c566a',
    '--cc-map-ctrl-icon-filter': 'brightness(0) invert(1)',
    '--cc-map-ctrl-shadow': 'rgba(76, 86, 106, 0.3)',
    '--cc-map-scale-bg': 'transparent',
    '--cc-map-scale-border': '#4c566a',
    '--cc-map-scale-text': '#d8dee9',

    // Map Visualization
    '--cc-map-background': '#2e3440',
    '--cc-snap-color': '#bf616a',
    '--cc-hover-highlight': '#ebcb8b',
    '--cc-select-highlight': '#88c0d0',
    '--cc-stroke-color': '#d8dee9',
    '--cc-stroke-light': 'rgba(216, 222, 233, 0.25)',
    '--cc-text-halo': '#2e3440',
    '--cc-text-halo-alt': 'rgba(0, 0, 0, 0.7)',
    '--cc-station-default': '#616e88',
    '--cc-gray-line': '#4c566a',
    '--cc-gray-text': '#616e88',
    '--cc-grid-default': '#434c5e',
    '--cc-zero-datum': '#ebcb8b',
    '--cc-compass-color': '#d8dee9',
    '--cc-depth-shallow': '#88c0d0',
    '--cc-depth-deep': '#bf616a',
    '--cc-depth-text': '#d8dee9',

    // Canvas Preview
    '--cc-preview-bg': '#2e3440',
    '--cc-preview-text': '#d8dee9',

    // Opacity Variants: accent
    '--cc-accent-5': 'rgba(136, 192, 208, 0.05)',
    '--cc-accent-10': 'rgba(136, 192, 208, 0.1)',
    '--cc-accent-20': 'rgba(136, 192, 208, 0.2)',
    '--cc-accent-30': 'rgba(136, 192, 208, 0.3)',
    '--cc-accent-50': 'rgba(136, 192, 208, 0.5)',
    '--cc-accent-70': 'rgba(136, 192, 208, 0.7)',
    '--cc-accent-80': 'rgba(136, 192, 208, 0.8)',
    '--cc-accent-90': 'rgba(136, 192, 208, 0.9)',

    // Opacity Variants: background
    '--cc-background-30': 'rgba(46, 52, 64, 0.3)',
    '--cc-background-50': 'rgba(46, 52, 64, 0.5)',
    '--cc-background-80': 'rgba(46, 52, 64, 0.8)',

    // Opacity Variants: panel
    '--cc-panel-20': 'rgba(59, 66, 82, 0.2)',
    '--cc-panel-50': 'rgba(59, 66, 82, 0.5)',
    '--cc-panel-90': 'rgba(59, 66, 82, 0.9)',

    // Opacity Variants: error
    '--cc-error-10': 'rgba(191, 97, 106, 0.1)',
    '--cc-error-20': 'rgba(191, 97, 106, 0.2)',
    '--cc-error-30': 'rgba(191, 97, 106, 0.3)',
    '--cc-error-80': 'rgba(191, 97, 106, 0.8)',
    '--cc-error-90': 'rgba(191, 97, 106, 0.9)',

    // Opacity Variants: warning
    '--cc-warning-5': 'rgba(235, 203, 139, 0.05)',
    '--cc-warning-10': 'rgba(235, 203, 139, 0.1)',
    '--cc-warning-20': 'rgba(235, 203, 139, 0.2)',
    '--cc-warning-30': 'rgba(235, 203, 139, 0.3)',

    // Opacity Variants: success
    '--cc-success-5': 'rgba(163, 190, 140, 0.05)',
    '--cc-success-10': 'rgba(163, 190, 140, 0.1)',
    '--cc-success-30': 'rgba(163, 190, 140, 0.3)',
  },
  catppuccin_mocha: {
    // UI Chrome
    '--cc-background': '#1e1e2e',
    '--cc-panel': '#181825',
    '--cc-border': '#313244',
    '--cc-text-primary': '#cdd6f4',
    '--cc-text-secondary': '#6c7086',
    '--cc-accent': '#89b4fa',
    '--cc-accent-on': '#1e1e2e',
    '--cc-warning': '#f9e2af',
    '--cc-error': '#f38ba8',
    '--cc-success': '#a6e3a1',
    '--cc-hover': '#181825',
    '--cc-focus-ring': '#89b4fa',
    '--cc-focus-glow': 'rgba(137, 180, 250, 0.5)',
    '--cc-scrollbar-track': '#181825',
    '--cc-scrollbar-thumb': '#313244',
    '--cc-scrollbar-hover': '#89b4fa',
    '--cc-input-bg': '#181825',
    '--cc-input-border': '#313244',
    '--cc-outside-month': '#6c7086',
    '--cc-selection-gradient': 'rgba(137, 180, 250, 0.3)',
    '--cc-overlay': 'rgba(0, 0, 0, 0.5)',

    // MapLibre Controls
    '--cc-map-ctrl-bg': '#181825',
    '--cc-map-ctrl-border': '#313244',
    '--cc-map-ctrl-hover': '#1e1e2e',
    '--cc-map-ctrl-active': '#313244',
    '--cc-map-ctrl-icon-filter': 'brightness(0) invert(1)',
    '--cc-map-ctrl-shadow': 'rgba(49, 50, 68, 0.3)',
    '--cc-map-scale-bg': 'transparent',
    '--cc-map-scale-border': '#313244',
    '--cc-map-scale-text': '#cdd6f4',

    // Map Visualization
    '--cc-map-background': '#1e1e2e',
    '--cc-snap-color': '#f38ba8',
    '--cc-hover-highlight': '#f9e2af',
    '--cc-select-highlight': '#89b4fa',
    '--cc-stroke-color': '#cdd6f4',
    '--cc-stroke-light': 'rgba(205, 214, 244, 0.25)',
    '--cc-text-halo': '#1e1e2e',
    '--cc-text-halo-alt': 'rgba(0, 0, 0, 0.7)',
    '--cc-station-default': '#6c7086',
    '--cc-gray-line': '#313244',
    '--cc-gray-text': '#6c7086',
    '--cc-grid-default': '#313244',
    '--cc-zero-datum': '#f9e2af',
    '--cc-compass-color': '#cdd6f4',
    '--cc-depth-shallow': '#94e2d5',
    '--cc-depth-deep': '#f38ba8',
    '--cc-depth-text': '#cdd6f4',

    // Canvas Preview
    '--cc-preview-bg': '#1e1e2e',
    '--cc-preview-text': '#cdd6f4',

    // Opacity Variants: accent
    '--cc-accent-5': 'rgba(137, 180, 250, 0.05)',
    '--cc-accent-10': 'rgba(137, 180, 250, 0.1)',
    '--cc-accent-20': 'rgba(137, 180, 250, 0.2)',
    '--cc-accent-30': 'rgba(137, 180, 250, 0.3)',
    '--cc-accent-50': 'rgba(137, 180, 250, 0.5)',
    '--cc-accent-70': 'rgba(137, 180, 250, 0.7)',
    '--cc-accent-80': 'rgba(137, 180, 250, 0.8)',
    '--cc-accent-90': 'rgba(137, 180, 250, 0.9)',

    // Opacity Variants: background
    '--cc-background-30': 'rgba(30, 30, 46, 0.3)',
    '--cc-background-50': 'rgba(30, 30, 46, 0.5)',
    '--cc-background-80': 'rgba(30, 30, 46, 0.8)',

    // Opacity Variants: panel
    '--cc-panel-20': 'rgba(24, 24, 37, 0.2)',
    '--cc-panel-50': 'rgba(24, 24, 37, 0.5)',
    '--cc-panel-90': 'rgba(24, 24, 37, 0.9)',

    // Opacity Variants: error
    '--cc-error-10': 'rgba(243, 139, 168, 0.1)',
    '--cc-error-20': 'rgba(243, 139, 168, 0.2)',
    '--cc-error-30': 'rgba(243, 139, 168, 0.3)',
    '--cc-error-80': 'rgba(243, 139, 168, 0.8)',
    '--cc-error-90': 'rgba(243, 139, 168, 0.9)',

    // Opacity Variants: warning
    '--cc-warning-5': 'rgba(249, 226, 175, 0.05)',
    '--cc-warning-10': 'rgba(249, 226, 175, 0.1)',
    '--cc-warning-20': 'rgba(249, 226, 175, 0.2)',
    '--cc-warning-30': 'rgba(249, 226, 175, 0.3)',

    // Opacity Variants: success
    '--cc-success-5': 'rgba(166, 227, 161, 0.05)',
    '--cc-success-10': 'rgba(166, 227, 161, 0.1)',
    '--cc-success-30': 'rgba(166, 227, 161, 0.3)',
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
