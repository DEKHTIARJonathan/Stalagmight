// Ghost-follow state machine for the drag preview (#mem drag latency).
//
// The moving "ghost" is a stock GeoJSON source whose `setData` round-trips
// through the MapLibre worker (parse + retile), so a bake lands SEVERAL frames
// after the pointermove. To keep the ghost glued to the cursor we apply a
// synchronous, viewport-anchored `*-translate` (no worker) every pointermove,
// while the periodic re-`setData` re-clips the real geometry (the reason the
// preview re-bakes at all: avoids large-offset wedges / shot-station skew).
//
// The naive version (translate = live - lastRequestedBake, rebased on any
// `sourcedata` gated by `isSourceLoaded`) ELASTICALLY OVERSHOOTS: with a bake
// issued every frame there are always several in flight, so when an EARLIER bake
// lands the displayed geometry advances but `isSourceLoaded` is still false (a
// later bake is pending) - the rebase is skipped, the translate reference stays
// behind the displayed geometry, and displayed = cursor + (displayedBake -
// staleRef) shoots past the cursor, snapping back only when motion stops and the
// queue drains. The `sourcedata` event never says WHICH bake landed, so any
// event->bake association under multi-flight is guesswork.
//
// This state machine removes the ambiguity by SINGLE-FLIGHT baking: at most one
// `setData` in flight, its bake position recorded on issue. The displayed
// geometry therefore always equals the last LANDED bake, and the translate is
// ALWAYS `live - landed`, so:
//
//     displayed = landed + translate = landed + (live - landed) = live
//
// holds after every move and every land, regardless of land timing. Bake cadence
// adapts: a bake is issued only when nothing is in flight AND the residual
// exceeds a pixel threshold, so slow precise drags bake rarely (tiny residual,
// no wedge) and fast drags bake back-to-back single-flight with the synchronous
// translate covering each gap.

/** Screen-pixel offset (drag delta), the currency of every position here. */
export interface GhostOffset {
  dx: number;
  dy: number;
}

/** Side effects the machine drives; the host (SurveyLayer) wires them to the
 *  real map. `bake` issues ONE preview `setData` at `pos` (and, in the host,
 *  arms the land confirmation); `translate` applies the screen-space
 *  `*-translate`. Both are synchronous from the machine's perspective. */
export interface GhostFollowHooks {
  bake: (pos: GhostOffset) => void;
  translate: (residual: GhostOffset) => void;
}

/** Re-bake once the residual (live - landed) grows past this many CSS px AND no
 *  bake is in flight. Small enough that the translated geometry never approaches
 *  the tile buffer (so no wedge), large enough that a precise nudge stays a pure
 *  translate with no worker traffic. */
export const GHOST_REBAKE_PX = 24;

export class GhostFollow {
  private live: GhostOffset = { dx: 0, dy: 0 };
  /** Bake position of the currently DISPLAYED geometry (last confirmed land). */
  private landed: GhostOffset = { dx: 0, dy: 0 };
  /** Bake position of the one in-flight `setData`, or null if none is pending. */
  private inFlight: GhostOffset | null = null;

  constructor(
    private readonly hooks: GhostFollowHooks,
    private readonly rebakePx: number = GHOST_REBAKE_PX,
  ) {}

  /** Begin a drag: reset to origin, zero the translate, and issue the first bake
   *  at offset 0 (the captured geometry's own position). */
  start(): void {
    this.live = { dx: 0, dy: 0 };
    this.landed = { dx: 0, dy: 0 };
    this.inFlight = null;
    this.hooks.translate({ dx: 0, dy: 0 });
    this.issue({ dx: 0, dy: 0 });
  }

  /** A pointermove (or a zoom-driven re-apply) at the new cursor offset. Applies
   *  the synchronous translate immediately, then bakes if warranted. */
  move(dx: number, dy: number): void {
    this.live = { dx, dy };
    this.applyTranslate();
    this.maybeBake();
  }

  /** The one in-flight bake's tiles have landed (its geometry now drawn). Adopt
   *  its recorded position as the displayed baseline, re-derive the translate
   *  from the live cursor (never a blind zero), and chain the next bake if the
   *  cursor has already moved past the threshold. No-op if nothing is pending, so
   *  a duplicate land signal (sourcedata + timeout fallback) is harmless. */
  land(): void {
    if (this.inFlight === null) return;
    this.landed = this.inFlight;
    this.inFlight = null;
    this.applyTranslate();
    this.maybeBake();
  }

  /** Whether a bake is currently in flight (host uses it to gate the land
   *  confirmation: exactly one pending means `isSourceLoaded` unambiguously
   *  identifies which bake landed). */
  hasBakeInFlight(): boolean {
    return this.inFlight !== null;
  }

  /** The displayed screen position = landed bake position + current translate.
   *  Invariant: equals the live cursor after every move/land. Exposed for the
   *  host's assertions + the unit test. */
  displayedOffset(): GhostOffset {
    const t = this.residual();
    return { dx: this.landed.dx + t.dx, dy: this.landed.dy + t.dy };
  }

  /** The live cursor offset (test/host read-back). */
  liveOffset(): GhostOffset {
    return { ...this.live };
  }

  private applyTranslate(): void {
    this.hooks.translate(this.residual());
  }

  private residual(): GhostOffset {
    return { dx: this.live.dx - this.landed.dx, dy: this.live.dy - this.landed.dy };
  }

  private maybeBake(): void {
    if (this.inFlight !== null) return;
    const r = this.residual();
    if (r.dx * r.dx + r.dy * r.dy > this.rebakePx * this.rebakePx) this.issue(this.live);
  }

  private issue(pos: GhostOffset): void {
    this.inFlight = { ...pos };
    this.hooks.bake({ ...pos });
  }
}
