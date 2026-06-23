/**
 * Fixed icon tints for the application (hamburger) menus. These are
 * menu-action colors — not survey-entity syntactic roles — so they live here
 * rather than in the syntactic palette. Shared by the GlobalView (start screen)
 * and SingleSystemView (in-project) menus. Hexes reuse the app's existing
 * palette where natural.
 */
export const MENU_ICON_COLORS = {
  new: '#5fcf83', // green
  open: '#0070dd', // blue
  save: '#3fb6b6', // teal
  export: '#2bb3e0', // cyan
  import: '#eab946', // amber
  close: '#9aa6b2', // gray
  projectSettings: '#9aa6b2', // gray
  projectDetails: '#0070dd', // blue
  settings: '#9aa6b2', // gray
  debug: '#a335ee', // purple
  quit: '#f75d59', // red
} as const;
