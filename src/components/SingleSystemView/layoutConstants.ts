/**
 * Shared layout bounds for the SingleSystemView panels.
 *
 * The bottom data-table ResizablePanel enforces these min/max heights, and the
 * section-focus height clamp (#50) reuses them so the focus height can never
 * drift out of the panel's own resize bounds if either is changed.
 */
export const DATA_TABLE_MIN_HEIGHT = 100;
export const DATA_TABLE_MAX_HEIGHT = 500;
