import { useEffect, useMemo, useState } from 'react';

/**
 * Viewport-driven squeeze for the two side Docks (#260).
 *
 * The side panels are sized in PIXELS and persisted, but the CSS viewport shrinks
 * with the native webview UI zoom (see src/utils/uiScale.ts). The map column is
 * the flex remainder, so at high zoom - or in a narrow window - the panels keep
 * their persisted widths and the map absorbs the entire shortfall, down to a
 * useless sliver. This module decides how wide each panel should RENDER for a
 * given viewport so the map always keeps `mapMinWidth`.
 *
 * CRITICAL: the result is a DISPLAY-TIME CLAMP, never a resize. It is a pure
 * function of the viewport plus the user's own persisted widths, so it is fully
 * reversible - when the viewport grows again the user's widths come straight
 * back - and it must never be routed into `setSectionsPanelWidth` /
 * `savePanelSizes`. Persisting a temporary 150px squeeze would leave the panel
 * tiny forever after the user zoomed back out, which is worse than the bug this
 * fixes. `useSidePanelSqueeze` therefore performs no store writes at all.
 */

/** One side panel's inputs to the squeeze decision. */
export interface SidePanelInput {
  /** The user's own width (px): the persisted/live store value, never modified. */
  width: number;
  /** Panel's resize minimum (PANEL_SIZE_BOUNDS[...].min). */
  min: number;
  /** Rendered at all? The Sections Dock is survey-only, so it can be absent. */
  present: boolean;
  /** Pinned open, i.e. it reflows the map. A hover-floating panel overlays the
   *  map instead of taking layout space, so it never needs squeezing. */
  pinnedOpen: boolean;
}

/** One side panel's decision. */
export interface SidePanelLayout {
  /** Width to RENDER at. Equals the input width unless squeezed. */
  width: number;
  /** Force the panel to its closed / hover-tab state for this viewport. */
  collapsed: boolean;
}

export interface SidePanelSqueeze {
  sections: SidePanelLayout;
  detail: SidePanelLayout;
}

export interface SidePanelSqueezeOpts {
  /** Width (CSS px) of the row that holds both panels plus the map column. */
  viewportWidth: number;
  /** Floor the map column must keep (MAP_MIN_WIDTH). */
  mapMinWidth: number;
  /** Width of a closed panel's opener bar (Dock's BAR). */
  barWidth: number;
  sections: SidePanelInput;
  detail: SidePanelInput;
}

/** Layout space a panel takes in a given candidate state. */
function occupied(panel: SidePanelInput, width: number, collapsed: boolean, barWidth: number): number {
  if (!panel.present) return 0;
  return panel.pinnedOpen && !collapsed ? width : barWidth;
}

/** Shrinkable slack a panel offers in a given candidate state. */
function slackOf(panel: SidePanelInput, collapsed: boolean): number {
  if (!panel.present || !panel.pinnedOpen || collapsed) return 0;
  return Math.max(0, panel.width - panel.min);
}

interface Attempt {
  /** The map reached `mapMinWidth` in this candidate state. */
  ok: boolean;
  sectionsWidth: number;
  detailWidth: number;
}

/**
 * Try one candidate collapse state: shrink whichever panels are still open
 * toward their minimums, splitting the shortfall in proportion to the slack each
 * one offers (a panel dragged far past its minimum gives up more than one already
 * near it, so neither collapses to a stub while the other stays luxurious).
 */
function attempt(
  opts: SidePanelSqueezeOpts,
  sectionsCollapsed: boolean,
  detailCollapsed: boolean,
): Attempt {
  const { viewportWidth, mapMinWidth, barWidth, sections, detail } = opts;
  let sectionsWidth = sections.width;
  let detailWidth = detail.width;

  const mapNow = () =>
    viewportWidth -
    occupied(sections, sectionsWidth, sectionsCollapsed, barWidth) -
    occupied(detail, detailWidth, detailCollapsed, barWidth);

  const deficit = mapMinWidth - mapNow();
  if (deficit <= 0) return { ok: true, sectionsWidth, detailWidth };

  const slackS = slackOf(sections, sectionsCollapsed);
  const slackD = slackOf(detail, detailCollapsed);
  const total = slackS + slackD;
  if (total <= 0) return { ok: false, sectionsWidth, detailWidth };

  const take = Math.min(deficit, total);
  // Round the sections share, give the exact remainder to detail, then clamp both
  // to their own slack - so rounding can never push a panel below its minimum and
  // the two shares still add up to `take`.
  let takeS = Math.min(Math.round((take * slackS) / total), slackS);
  let takeD = Math.min(take - takeS, slackD);
  const unassigned = take - takeS - takeD;
  if (unassigned > 0) {
    const extraS = Math.min(unassigned, slackS - takeS);
    takeS += extraS;
    takeD += Math.min(unassigned - extraS, slackD - takeD);
  }
  sectionsWidth -= takeS;
  detailWidth -= takeD;

  return { ok: takeS + takeD >= deficit, sectionsWidth, detailWidth };
}

/**
 * Decide how wide each side panel should render, and whether either must fall
 * back to its closed / hover-tab state, so the map keeps `mapMinWidth`.
 *
 * Escalation, least invasive first:
 *   1. Nothing changes if the map already clears its floor.
 *   2. Shrink the open panels toward their PANEL_SIZE_BOUNDS minimums.
 *   3. Still short -> collapse DETAILS (a view of the current selection, one
 *      click away again from that selection) and re-solve, which may let Sections
 *      keep more than its minimum.
 *   4. Still short -> collapse SECTIONS too (primary navigation, so it goes last).
 * A collapsed panel is still reachable: its opener tab floats it over the map,
 * which costs no layout width.
 *
 * A non-positive `viewportWidth` means "not measured yet" (first paint, or a
 * zero-layout test environment) and is passed through untouched, so nothing
 * collapses on the strength of a degenerate measurement.
 */
export function computeSidePanelLayout(opts: SidePanelSqueezeOpts): SidePanelSqueeze {
  const { viewportWidth, sections, detail } = opts;

  const build = (
    r: Attempt,
    sectionsCollapsed: boolean,
    detailCollapsed: boolean,
  ): SidePanelSqueeze => ({
    // Report `collapsed` only for a panel that actually had layout width to give
    // up, so the flag always means "this viewport took it away from you".
    sections: {
      width: sectionsCollapsed ? sections.width : r.sectionsWidth,
      collapsed: sectionsCollapsed && sections.present && sections.pinnedOpen,
    },
    detail: {
      width: detailCollapsed ? detail.width : r.detailWidth,
      collapsed: detailCollapsed && detail.present && detail.pinnedOpen,
    },
  });

  const untouched: SidePanelSqueeze = {
    sections: { width: sections.width, collapsed: false },
    detail: { width: detail.width, collapsed: false },
  };
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return untouched;

  const both = attempt(opts, false, false);
  if (both.ok) return build(both, false, false);

  // Escalating must never hand width BACK. Re-solving from the user's original
  // widths would return the space freed by collapsing Details to Sections, so a
  // panel could render WIDER at a smaller viewport (measured: 229px at a 838px
  // viewport but 284px at 700px, i.e. it grew as the user zoomed in further).
  // Carry the already-squeezed widths forward as the new starting point, which
  // makes the rendered width monotonically non-increasing in the viewport.
  const squeezed: SidePanelSqueezeOpts = {
    ...opts,
    sections: { ...opts.sections, width: both.sectionsWidth },
    detail: { ...opts.detail, width: both.detailWidth },
  };

  const noDetail = attempt(squeezed, false, true);
  if (noDetail.ok) return build(noDetail, false, true);

  // Both collapsed is the floor: if the map still can't reach its minimum the
  // window is narrower than two opener bars plus the map minimum, and there is
  // nothing further to give.
  return build(attempt(squeezed, true, true), true, true);
}

/**
 * Observe an element's content-box width. Returns 0 until the first measurement,
 * which `computeSidePanelLayout` reads as "not measured yet".
 */
export function useElementWidth(el: HTMLElement | null): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!el) {
      setWidth(0);
      return undefined;
    }
    // ResizeObserver is absent in the node test tier; fall back to the one-shot
    // measurement so the hook degrades to "measured once" instead of throwing.
    setWidth(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w != null) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return width;
}

/**
 * `computeSidePanelLayout` bound to a live container element.
 *
 * Deliberately read-only with respect to the UI store: it takes the user's widths
 * as plain numbers and returns display values. Nothing here writes back, so a
 * viewport-driven squeeze can never be mistaken for a user drag and reach
 * `savePanelSizes`.
 */
export function useSidePanelSqueeze(
  container: HTMLElement | null,
  opts: Omit<SidePanelSqueezeOpts, 'viewportWidth'>,
): SidePanelSqueeze {
  const viewportWidth = useElementWidth(container);
  const { mapMinWidth, barWidth, sections, detail } = opts;
  return useMemo(
    () =>
      computeSidePanelLayout({ viewportWidth, mapMinWidth, barWidth, sections, detail }),
    [viewportWidth, mapMinWidth, barWidth, sections, detail],
  );
}
