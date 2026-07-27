import { useCallback, useEffect, useMemo, useState } from 'react';

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
   *  map instead of taking layout space, so it is never squeezed FOR THE MAP -
   *  it is still capped at the container it floats inside. */
  pinnedOpen: boolean;
}

/** One side panel's decision. */
export interface SidePanelLayout {
  /** Width to RENDER at. Equals the input width unless squeezed, and never
   *  exceeds the measured viewport (see `fit` in computeSidePanelLayout). */
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
  //
  // The lower clamp on `takeD` is load-bearing, not defensive: rounding UP the
  // sections share can make it exceed `take` itself (slackD === 0 and a `take`
  // whose fraction is >= 0.5 - e.g. a hover-mode Details panel at viewport
  // 555.5), which left `take - takeS` negative and `detailWidth -= takeD` then
  // WIDENED Details by up to half a pixel past the width the user set.
  let takeS = Math.min(Math.round((take * slackS) / total), slackS);
  let takeD = Math.max(0, Math.min(take - takeS, slackD));
  // Rounding the other way (down) can leave a sliver unassigned once detail is
  // already at its own slack ceiling. Only reachable on a FRACTIONAL viewport -
  // with integer inputs the shortfall is an integer below 0.5, i.e. zero - which
  // is exactly what a non-integer UI-zoom step produces (measured: viewport
  // 710.9 leaves 0.1px unassigned). Hand it to whichever panel can still take it,
  // or the map ends up a fraction short of its floor.
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
 *      click away again from that selection) and re-solve. Sections cannot gain
 *      from that: reaching this step means the both-open squeeze already ran out
 *      of slack, so Sections is at its minimum and the freed width goes to the
 *      map (see the carry-forward below).
 *   4. Still short -> collapse SECTIONS too (primary navigation, so it goes last).
 * A collapsed panel is still reachable: its opener tab floats it over the map,
 * which costs no layout width.
 *
 * A non-positive `viewportWidth` means "not measured yet" (first paint, or a
 * zero-layout test environment) and is passed through untouched, so nothing
 * collapses on the strength of a degenerate measurement.
 */
/**
 * What size a resize drag's `requested` value should actually write.
 *
 * The other half of the display-only rule above, and the one it is easy to miss:
 * the squeeze must not be routed OUT of the store, but a drag can route it back
 * IN. A Dock renders at `display`, so `useResizeHandle` measures the SQUEEZED
 * panel - and any size above the clamp is unreachable, because the squeeze
 * re-applies on the same frame and the edge does not move. Writing it anyway
 * replaced the user's own `user` width with a number the drag only appeared to
 * reach: a panel squeezed from 400px to its 200px minimum, dragged wider, looked
 * inert and then came back at the dragged width instead of 400 once the viewport
 * grew again - a silent, unattributable loss of their layout.
 *
 * Shrinking stays reachable while squeezed (a smaller panel is always
 * affordable), so only the direction the screen cannot honour is clamped, and the
 * drag does exactly what it visibly appears to do either way.
 *
 * This CLAMPS rather than refusing, because refusing was itself lossy. `display`
 * and `user` are both re-read every render, so the drag mutates its own inputs: a
 * shrink-then-grow inside ONE squeezed drag lowers `user` on the way down, the
 * panel becomes unsqueezed at the new size, and the grow then lands one step past
 * the fresh clamp. The end-of-drag persist saw only that final unreachable number
 * and wrote NOTHING - so the shrink the user did reach was dropped too, and the
 * pre-drag width came back on reload.
 *
 * The clamp target is `user`, not `display`: `user` is the size the panel WOULD
 * render at with room to do so, which is exactly what the store is for, while
 * `display` is a temporary consequence of this viewport. Clamping to `display`
 * would re-introduce the original defect from the other side - the squeezed 400px
 * panel would come back as 200 - so an unreachable request resolves to "leave your
 * own size alone", which persists whatever the reachable part of the drag reached.
 */
export function resolveResize(display: number, user: number, requested: number): number {
  // Not squeezed: the rendering IS the user's own size, so every request is real.
  if (display >= user) return requested;
  // Reachable while squeezed: the edge really did move there.
  if (requested <= display) return requested;
  return user;
}

export function computeSidePanelLayout(opts: SidePanelSqueezeOpts): SidePanelSqueeze {
  const { viewportWidth, sections, detail } = opts;

  // Ceiling applied to EVERY branch, squeezed or not. The reported width is what
  // the panel RENDERS at (the Dock's `size`) and where the Data overlay's inset
  // stops, and both live inside this same container - but the two branches that
  // skip the squeeze (a collapsed panel, reporting the user's own width so it
  // returns intact, and a hover-mode panel, which is never squeezed at all) can
  // still be FLOATED open at that width. Unclamped, a persisted 284px panel
  // floated over a 200px container puts its edge - and the Data overlay inset
  // that tracks it - outside the box, which is the same class of failure the
  // squeeze exists to prevent. Floating deliberately still doesn't reflow the
  // map; this only stops it exceeding the container.
  //
  // Flooring makes the two axes agree (the vertical path already floors): a
  // non-integer UI-zoom step yields a fractional viewport, and the shares above
  // are only rounded on the sections side, so detail could emit a half-pixel
  // width straight into `style.width`. Flooring alone cannot breach a panel's
  // resize minimum (the minimums are integers and the width is >= its minimum
  // first); the CONTAINER can, when it is itself narrower than the minimum - and
  // there the container has to win, since a panel wider than the box it is
  // positioned in has nowhere to put the surplus.
  const fit = (w: number) => Math.floor(Math.min(w, viewportWidth));

  const build = (
    r: Attempt,
    sectionsCollapsed: boolean,
    detailCollapsed: boolean,
  ): SidePanelSqueeze => ({
    // Report `collapsed` only for a panel that actually had layout width to give
    // up, so the flag always means "this viewport took it away from you".
    sections: {
      width: fit(sectionsCollapsed ? sections.width : r.sectionsWidth),
      collapsed: sectionsCollapsed && sections.present && sections.pinnedOpen,
    },
    detail: {
      width: fit(detailCollapsed ? detail.width : r.detailWidth),
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

// ---------------------------------------------------------------------------
// The same policy on the VERTICAL axis, for the bottom Data dock.
//
// Simpler than the horizontal case because there is only one panel to solve for -
// no proportional split, no ordering question about which collapses first - but
// the defect is identical: a pixel height persisted up to 500 against a Main box
// that shrinks with the UI zoom, and a `flex-shrink-0` spacer that wins outright,
// leaving the `flex-1` map wrapper at 0px.
// ---------------------------------------------------------------------------

export interface DataPanelSqueezeOpts {
  /** Height (CSS px) of the column that holds the map plus the Data panel. */
  viewportHeight: number;
  /** The user's own height (px): the persisted/live store value, never modified. */
  height: number;
  /** Panel's resize minimum (PANEL_SIZE_BOUNDS['data-table'].min). */
  min: number;
  /** Floor the map row must keep (MAP_MIN_HEIGHT). */
  mapMinHeight: number;
  /** Pinned open, i.e. it reflows the map. A hover-floating panel overlays it. */
  pinnedOpen: boolean;
}

export interface DataPanelLayout {
  /** Height to RENDER at. Equals the input height unless squeezed, and never
   *  exceeds the measured viewport - a floating or viewport-collapsed panel is
   *  not squeezed but is still capped (see computeDataPanelLayout). */
  height: number;
  /** Force the panel to its closed / hover-tab state for this viewport. */
  collapsed: boolean;
}

/**
 * Decide how tall the Data panel should render, and whether it must fall back to
 * its closed / hover-tab state, so the map keeps `mapMinHeight`.
 *
 * Same escalation and the same DISPLAY-TIME-ONLY rule as
 * {@link computeSidePanelLayout}: shrink toward the resize minimum first, collapse
 * only when even the minimum will not fit, and never write the result back to the
 * store (a temporary squeeze persisted would leave the panel tiny forever).
 *
 * A non-positive `viewportHeight` means "not measured yet" and is passed through
 * untouched, so nothing collapses on a degenerate measurement.
 */
export function computeDataPanelLayout(opts: DataPanelSqueezeOpts): DataPanelLayout {
  const { viewportHeight, height, min, mapMinHeight, pinnedOpen } = opts;
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return { height, collapsed: false };
  // Ceiling applied to EVERY branch below, whether the panel reflows the map or
  // not. The reported height renders the panel (the Dock's `size`) AND feeds both
  // side Docks' `closedBottomInset`, which raises a minimized side bar's bottom
  // edge - and that inset is taken from the SAME container. Once it reaches the
  // container's height the side bar computes to height 0, the Data tab is clipped
  // above Main's top, and the panel can no longer be closed: precisely the
  // failure MAP_MIN_HEIGHT exists to prevent, reached through the two branches
  // that skip the squeeze. Both are reachable with the panel visibly OPEN - a
  // hover-mode panel floats at its persisted height, and a viewport-collapsed one
  // reports the user's height and can still be floated open at it - so the cap
  // cannot be conditional on `pinnedOpen` or on `collapsed`.
  //
  // The cap therefore has to be the SAME floor the squeeze enforces, not the bare
  // container: capping at `viewportHeight` allows equality, and a persisted height
  // at or above the container yielded exactly `viewportHeight` - which is the
  // height-0 side bar and the 0px map, i.e. the cap let through the one value it
  // existed to stop. `Math.max(0, ...)` covers a container smaller than the map
  // floor itself, where no height leaves a map and the least-bad answer is to give
  // the side bars their full height so the Data tab stays reachable. None of this
  // is persisted, so the user's own height still returns when the viewport grows.
  const fits = Math.min(height, Math.max(0, Math.floor(viewportHeight - mapMinHeight)));
  // A floating (hover) panel overlays the map instead of taking layout height, so
  // there is nothing to squeeze FOR THE MAP: it is only capped at the container.
  if (!pinnedOpen) return { height: fits, collapsed: false };

  const available = viewportHeight - mapMinHeight;
  if (height <= available) return { height, collapsed: false };
  // Shrink toward the resize minimum. Note `min` is a floor on the RENDERED
  // height, not on what fits: below it the panel is unusable, so collapsing to the
  // opener bar is the honest outcome rather than a stub the user cannot read.
  if (available >= min) return { height: Math.floor(available), collapsed: false };
  // Even the minimum starves the map: fall back to the opener bar, which is
  // reachable (its tab floats the panel over the map at no layout cost) and is the
  // floor - if the map still cannot reach its minimum beside a bar, there is
  // nothing further to give. The height is reported un-squeezed apart from the cap
  // above, so the user's value is what returns when the viewport grows.
  return { height: fits, collapsed: true };
}

/** Stable "not measured yet" value, so the first render has one object identity. */
const ZERO_SIZE = { width: 0, height: 0 };

/**
 * Observe an element's BORDER-box size. Returns 0 for either axis until the first
 * measurement, which the compute functions read as "not measured yet".
 *
 * Both readings (the initial one-shot and every ResizeObserver callback) go
 * through `getBoundingClientRect` on purpose. The first cut mixed boxes - a
 * border box on mount and `entry.contentRect` (a CONTENT box) afterwards - which
 * agreed only because the observed element happens to have no padding or border;
 * an unenforced precondition is not something a pixel-accounting module should
 * rest on, and adding a 1px border to Main would have silently shifted every
 * squeeze decision by 2px on the resize path only. The border box is also the
 * closer match to what the callers need: the panels are absolutely positioned
 * inside this element, so what they can occupy is its padding box.
 */
export function useElementSize(el: HTMLElement | null): { width: number; height: number } {
  const [size, setSize] = useState(ZERO_SIZE);
  // Keep the SAME object when the numbers have not moved. Returning `prev` makes
  // React bail out of the re-render, which is load-bearing rather than an
  // optimization: a caller that recreates its element on each render (the squeeze
  // tests do exactly that) re-runs this effect every render, and a fresh
  // `{width, height}` with identical values would re-render forever. It also keeps
  // the object identity stable for callers' `useMemo` dependency lists.
  const apply = useCallback((width: number, height: number) => {
    setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
  }, []);

  useEffect(() => {
    if (!el) {
      apply(0, 0);
      return undefined;
    }
    // ResizeObserver is absent in the node test tier; fall back to the one-shot
    // measurement so the hook degrades to "measured once" instead of throwing.
    const read = () => {
      const rect = el.getBoundingClientRect();
      apply(rect.width, rect.height);
    };
    read();
    if (typeof ResizeObserver === 'undefined') return undefined;
    // Re-read the rect rather than trusting `entry.contentRect`: same box on
    // every path (see the doc comment). Layout is already settled when the
    // callback runs, so this forces no extra reflow.
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el, apply]);
  return size;
}

/**
 * Observe an element's border-box width. Returns 0 until the first measurement,
 * which `computeSidePanelLayout` reads as "not measured yet".
 */
export function useElementWidth(el: HTMLElement | null): number {
  return useElementSize(el).width;
}

/**
 * `computeDataPanelLayout` bound to a live container element. Read-only with
 * respect to the UI store, exactly like {@link useSidePanelSqueeze}.
 */
export function useDataPanelSqueeze(
  container: HTMLElement | null,
  opts: Omit<DataPanelSqueezeOpts, 'viewportHeight'>,
): DataPanelLayout {
  const { height: viewportHeight } = useElementSize(container);
  const { height, min, mapMinHeight, pinnedOpen } = opts;
  return useMemo(
    () => computeDataPanelLayout({ viewportHeight, height, min, mapMinHeight, pinnedOpen }),
    [viewportHeight, height, min, mapMinHeight, pinnedOpen],
  );
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
