import type { MockCommandFamily } from './types';

/**
 * Plan-mode commands of the Playwright IPC mock: dive-plan persistence (#244), the
 * plan anchors that keep a pin on its station across survey edits (#310), and the
 * gas-weighted reach field (`compute_gas_reach_field`).
 *
 * Split out of `../tauri-ipc.ts` unchanged (#576 E8). Runs IN THE PAGE: `setupTauriMocks`
 * serializes this factory with `Function.prototype.toString` into its init script, so it
 * may use only `ctx` and browser globals - never an import (type-only imports are erased).
 */
export const gasPlanCommands: MockCommandFamily = (ctx) => {
  // #310: live plan pins are kept as opaque ANCHORS beside their positional refs, so a
  // survey edit that renumbers stations doesn't silently retarget them. The real backend
  // names a station by the shots on either side of it (core/state/dive_plan.rs's
  // `PlanAnchor`); this mock mirrors that NEIGHBOUR-PAIR semantics only - no reverse-parity
  // or terminal-shot-length tracking, since the mock only needs to survive the shot
  // add/delete an e2e can actually drive. The anchor shape below is this mock's own and is
  // opaque to the app (`PlanAnchor` is `unknown` on the TS side).
  interface MockPlanRefLite {
    section_id: number;
    station_index: number;
  }
  interface MockPlanAnchor {
    section_id: number;
    before_shot_uuid: string | null;
    after_shot_uuid: string | null;
  }
  interface MockShotRef {
    id: number;
    uuid?: string;
  }
  interface MockSectionRef {
    id: number;
    shots: MockShotRef[];
  }
  const sectionForAnchor = (sectionId: number): MockSectionRef | undefined =>
    (ctx.currentProject()?.sections as MockSectionRef[] | undefined)?.find(
      (s) => s.id === sectionId,
    );
  /** Describe the station at `ref` by the uuids of its neighbouring shots (station `i` sits
   *  between shot `i-1` and shot `i`; a section end has no neighbour on that side). `null`
   *  when the section is gone or the index is out of range - mirrors the backend's
   *  `to_anchor`. */
  const refToAnchor = (ref: MockPlanRefLite | null | undefined): MockPlanAnchor | null => {
    if (!ref) return null;
    const section = sectionForAnchor(ref.section_id);
    if (!section || ref.station_index < 0 || ref.station_index > section.shots.length) {
      return null;
    }
    const before = ref.station_index > 0 ? section.shots[ref.station_index - 1] : undefined;
    const after =
      ref.station_index < section.shots.length ? section.shots[ref.station_index] : undefined;
    return {
      section_id: ref.section_id,
      before_shot_uuid: before?.uuid ?? null,
      after_shot_uuid: after?.uuid ?? null,
    };
  };
  /** Place an anchor against the project as it stands now, following the backend's
   *  `resolve_anchor` rules: with BOTH neighbours found the station is the boundary between
   *  them regardless of which now comes first (`pa < pb ? pa+1 : pa` - the order-agnosticism
   *  is what makes a reverse a no-op for interior stations); with one side that was NEVER
   *  recorded (a section END at capture), the station follows its sole shot to whichever end
   *  it currently touches (a reverse carries station 0 to station N and back); with one side
   *  recorded but deleted, the surviving side keeps its directional meaning. `null` only when
   *  NEITHER uuid is found anymore. */
  const anchorToRef = (anchor: MockPlanAnchor | null | undefined): MockPlanRefLite | null => {
    if (!anchor) return null;
    const section = sectionForAnchor(anchor.section_id);
    if (!section) return null;
    const find = (u: string | null) =>
      u ? section.shots.findIndex((s) => s.uuid === u) : -1;
    const pa = find(anchor.before_shot_uuid);
    const pb = find(anchor.after_shot_uuid);
    const n = section.shots.length;
    if (pa >= 0 && pb >= 0) {
      return { section_id: anchor.section_id, station_index: pa < pb ? pa + 1 : pa };
    }
    if (pa >= 0) {
      if (anchor.after_shot_uuid === null) {
        // Tail-end station at capture: stay on the end its shot touches now.
        const idx = pa === 0 ? 0 : n;
        return { section_id: anchor.section_id, station_index: idx };
      }
      return { section_id: anchor.section_id, station_index: pa + 1 };
    }
    if (pb >= 0) {
      if (anchor.before_shot_uuid === null) {
        // Head-end station at capture: stay on the end its shot touches now.
        const idx = pb === n - 1 ? n : 0;
        return { section_id: anchor.section_id, station_index: idx };
      }
      return { section_id: anchor.section_id, station_index: pb };
    }
    return null;
  };

  // Dive-plan (.plnx) mock store (#244): an in-memory list of saved plans for the
  // open project. Reset per test via __MOCK_RESET_DIVE_PLANS__.
  let mockDivePlans: Array<{
    id: number;
    name: string;
    created_at: string;
    updated_at: string;
    snapshot: unknown;
  }> = [];
  let mockDivePlanNextId = 1;
  let mockDivePlanClock = 0;
  const nextDivePlanStamp = () => {
    mockDivePlanClock += 1;
    return `2026-07-06T10:00:${String(mockDivePlanClock).padStart(2, '0')}Z`;
  };

  (window as unknown as Record<string, unknown>).__MOCK_RESET_DIVE_PLANS__ = () => {
    mockDivePlans = [];
    mockDivePlanNextId = 1;
    mockDivePlanClock = 0;
  };
  (window as unknown as Record<string, unknown>).__MOCK_GET_DIVE_PLANS__ = () => [...mockDivePlans];

  return (cmd, args) => {
    switch (cmd) {
      // Dive-plan persistence (#244). An in-memory mirror of the .plnx store.
      case 'list_dive_plans':
        return mockDivePlans.map((p) => ({
          id: p.id,
          name: p.name,
          created_at: p.created_at,
          updated_at: p.updated_at,
        }));
      case 'load_dive_plan': {
        const found = mockDivePlans.find((p) => p.id === args?.id);
        if (!found) throw new Error('That dive plan no longer exists.');
        // #310: this mock keeps a plan's refs POSITIONAL (unlike the real `.plnx`, which
        // canonicalizes to shot-uuid anchors on save), so the anchors below are derived
        // fresh at load time against the CURRENT survey - exactly what a real load would
        // hand back for a plan whose refs happen to still be current.
        const snap = (found.snapshot ?? {}) as {
          origin?: MockPlanRefLite | null;
          endpoint?: MockPlanRefLite | null;
          waypoints?: MockPlanRefLite[];
          marked_points?: Array<{ station: MockPlanRefLite; label?: string | null }>;
          stage_drop_overrides?: Array<MockPlanRefLite | null>;
        };
        return {
          meta: {
            id: found.id,
            name: found.name,
            created_at: found.created_at,
            updated_at: found.updated_at,
          },
          snapshot: found.snapshot,
          stale_ref_count: 0,
          anchors: {
            origin: refToAnchor(snap.origin ?? null),
            endpoint: refToAnchor(snap.endpoint ?? null),
            waypoints: (snap.waypoints ?? []).map((w) => refToAnchor(w)),
            marked_points: (snap.marked_points ?? []).map((m) => refToAnchor(m.station)),
            stage_drop_overrides: (snap.stage_drop_overrides ?? []).map((r) =>
              refToAnchor(r ?? null),
            ),
          },
        };
      }
      case 'save_dive_plan': {
        const id = (args?.id ?? null) as number | null;
        const name = args?.name as string;
        const snapshot = args?.snapshot;
        const stamp = nextDivePlanStamp();
        if (id === null) {
          const plan = {
            id: mockDivePlanNextId,
            name,
            created_at: stamp,
            updated_at: stamp,
            snapshot,
          };
          mockDivePlanNextId += 1;
          mockDivePlans.push(plan);
          return {
            id: plan.id,
            name: plan.name,
            created_at: plan.created_at,
            updated_at: plan.updated_at,
          };
        }
        const existing = mockDivePlans.find((p) => p.id === id);
        if (!existing) throw new Error('That dive plan no longer exists.');
        existing.name = name;
        existing.updated_at = stamp;
        existing.snapshot = snapshot;
        return {
          id: existing.id,
          name: existing.name,
          created_at: existing.created_at,
          updated_at: existing.updated_at,
        };
      }
      case 'delete_dive_plan': {
        const before = mockDivePlans.length;
        mockDivePlans = mockDivePlans.filter((p) => p.id !== args?.id);
        if (mockDivePlans.length === before) {
          throw new Error('That dive plan no longer exists.');
        }
        return null;
      }

      // #310: anchor / re-resolve live plan pins across a survey edit. Recorded together in
      // one call log (both commands round-trip the same opaque anchor shape).
      case 'plan_anchors_for_refs': {
        const refs = (args?.refs ?? []) as Array<MockPlanRefLite | null>;
        const anchors = refs.map((ref) => refToAnchor(ref));
        const win = window as unknown as Record<string, unknown>;
        const calls = (win.__MOCK_ANCHOR_CALLS__ as unknown[]) ?? [];
        calls.push({ cmd: 'plan_anchors_for_refs', refs, anchors });
        win.__MOCK_ANCHOR_CALLS__ = calls;
        return anchors;
      }
      case 'plan_refs_for_anchors': {
        const anchors = (args?.anchors ?? []) as Array<MockPlanAnchor | null>;
        const refs = anchors.map((a) => anchorToRef(a));
        const win = window as unknown as Record<string, unknown>;
        const calls = (win.__MOCK_ANCHOR_CALLS__ as unknown[]) ?? [];
        calls.push({ cmd: 'plan_refs_for_anchors', anchors, refs });
        win.__MOCK_ANCHOR_CALLS__ = calls;
        return refs;
      }
      case 'compute_gas_reach_field': {
        // Record every call's inputs so drag e2e can assert the dragged station was sent as a
        // per-stage override (#246). Keyed on the camelCase arg the frontend actually invokes with.
        {
          const win = window as unknown as Record<string, unknown>;
          const calls = (win.__MOCK_GAS_REACH_CALLS__ as unknown[]) ?? [];
          calls.push({
            stageDropOverrides: args?.stageDropOverrides ?? [],
            endpoint: args?.endpoint ?? null,
            origin: args?.origin ?? null,
            // #298: the ordered way points, so an e2e can assert the pick reached the engine
            // and in what order.
            waypoints: args?.waypoints ?? [],
            // #317: the per-span speed + propulsion, so an e2e can assert a segment edit
            // reached the engine rather than only re-rendering the table.
            segments: args?.segments ?? [],
            // #317: the rig itself, so disabling it can be proven at the REQUEST - the
            // readout that gates on it also gates on the client-side `hasDpvRig` flag, which
            // flips a render tick before any recompute round-trips.
            dpv: (args?.gasConfig as { dpv?: unknown } | undefined)?.dpv ?? null,
          });
          win.__MOCK_GAS_REACH_CALLS__ = calls;
        }
        // Gas reachable-frontier field (#38). No real graph in the mock -
        // synthesize a field from each station's mock x-coordinate (origin at
        // x=0) so the overlay + legend + turn markers have finite values to
        // render. Diver/cylinders/gasConfig inputs are ignored; the budget is a
        // fixed plausible value so far-enough stations fall outside it.
        const state = ctx.invoke('get_project_state', args) as
          | {
              stations?: Array<{
                station_ref: { section_id: number; station_index: number };
                coordinates: { x: number; y: number; z: number };
              }>;
            }
          | null;
        const stations = state?.stations ?? [];
        const budget_litres = 1500;
        const gas_to_reach: (number | null)[] = stations.map((s) => Math.abs(s.coordinates.x) * 20);
        // #395: keep the LAST station genuinely UNCONNECTED (gas_to_reach null)
        // BEFORE computing `reachable` - mirrors the real backend invariant
        // (src-tauri/src/models/project/gas.rs: reachable requires g.is_finite())
        // so a null gas_to_reach can never pair with reachable:true. Specs can
        // then assert the three-way split: grey (unconnected, reachable:false,
        // gas_to_reach:null) vs dimmed-but-colored (beyond gas range,
        // reachable:false, gas_to_reach:non-null) vs reachable.
        if (gas_to_reach.length > 0) {
          gas_to_reach[gas_to_reach.length - 1] = null;
        }
        const reachable = gas_to_reach.map((g) => g !== null && g <= budget_litres);
        let max_reachable_gas = 0;
        for (let i = 0; i < gas_to_reach.length; i += 1) {
          const g = gas_to_reach[i];
          if (reachable[i] && g !== null && g !== undefined && g > max_reachable_gas) {
            max_reachable_gas = g;
          }
        }
        // Turn frontier: a reachable station whose next (by array order) is not
        // reachable - enough for the marker layer to render in the smoke test.
        const turn_frontier = stations
          .filter((_s, i) => reachable[i] && i + 1 < stations.length && !reachable[i + 1])
          .map((s) => s.station_ref);
        // Staged-strategy drops + the readout gauges (Half-Minus). Mirror the backend: only the
        // staged strategies carry drops, and only when the rig actually has enough Stage
        // cylinders (else it falls back to All-thirds). The endpoint, when given + reachable, is
        // the route target (else the deepest reachable station). Exact math is unit-tested in
        // Rust; the mock just produces plausible, shape-correct values for the UI wiring.
        const gasConfig = (args?.gasConfig ?? {}) as {
          default_reserve?: string;
          reserve_profile?: { stage_reserve_bar?: number; all_thirds_safety_margin_bar?: number };
          conservative_tank_gas?: boolean;
          swim_speed_m_per_min?: number;
          survey_speed_m_per_min?: number | null;
          dpv?: {
            primary?: { speed_m_per_min?: number; burn_minutes?: number };
            backup?: { speed_m_per_min?: number; burn_minutes?: number };
            range_reserve_fraction?: number;
          } | null;
        };
        const cylinders = (args?.cylinders ?? []) as Array<{
          role?: string;
          fill_bar?: number;
          water_volume_l?: number;
          rated_pressure_bar?: number;
          enabled?: boolean;
          usable_gas_bar?: number;
        }>;
        const requested = gasConfig.default_reserve ?? 'all_thirds';
        // Disabled tanks (#245) are excluded from the gauges/drops, mirroring the engine.
        const stageCyls = cylinders.filter((c) => c.role === 'stage' && c.enabled !== false);
        const required = requested === 'two_stage' ? 2 : requested === 'one_stage' ? 1 : 0;
        const effective = stageCyls.length >= required ? requested : 'all_thirds';
        const dropCount = effective === 'two_stage' ? 2 : effective === 'one_stage' ? 1 : 0;
        const reserve = gasConfig.reserve_profile?.stage_reserve_bar ?? 30;

        const reachableRefs = stations
          .filter((_s, i) => reachable[i])
          .map((s) => s.station_ref);
        let deepestIdx = -1;
        let deepestGas = -1;
        for (let i = 0; i < gas_to_reach.length; i += 1) {
          const g = gas_to_reach[i];
          if (reachable[i] && g !== null && g !== undefined && g > deepestGas) {
            deepestGas = g;
            deepestIdx = i;
          }
        }
        const endpoint = (args?.endpoint ?? null) as {
          section_id: number;
          station_index: number;
        } | null;
        const endpointReachable =
          endpoint != null &&
          reachableRefs.some(
            (r) =>
              r.section_id === endpoint.section_id && r.station_index === endpoint.station_index,
          );
        const targetRef = endpointReachable
          ? endpoint
          : deepestIdx >= 0
            ? stations[deepestIdx].station_ref
            : null;
        const final_turn_ref = targetRef;
        // Mirrors the engine's own flag: true when the endpoint IS the target, false for the
        // deepest-in-budget fallback (no endpoint set, or one that cannot be used). The mock has
        // no partial walk toward an out-of-reach endpoint, so those two cases are all it can
        // distinguish - enough to keep the panel's two messages apart.
        const turn_toward_endpoint = endpointReachable && endpoint != null;
        // Drop stages: staged presets drop their first `dropCount` enabled stages; Free drops
        // every enabled stage with a positive usable (no cap). Each gets a ref, clamped to the
        // turnaround when the route is shorter - mirroring the engine so refs/bars/distances align.
        const dropSourceStages =
          effective === 'free'
            ? stageCyls.filter((c) => (c.usable_gas_bar ?? 0) > 0)
            : stageCyls.slice(0, dropCount);
        const stage_drop_refs = reachableRefs.length
          ? dropSourceStages.map(
              (_c, i) => reachableRefs[Math.min(i + 1, reachableRefs.length - 1)],
            )
          : [];
        // Apply per-stage drop overrides (#246): pin a drop to its dragged station and flag it
        // over-reserve when that station sits DEEPER (more gas-to-reach) than the strategy drop.
        // ⚠ This is a DELIBERATELY simplified stand-in, NOT the engine's rule: the engine flags
        // over-reserve on `contribution > safe_in_litres` (with a pin-to-default no-op) and folds
        // the budget/turn/reach; the mock only moves the ref + sets a station-depth flag and keeps
        // the budget fixed. So the e2e asserts UI WIRING (colour, reset, warning) only; the flag
        // semantics + the recompute math are covered by the Rust unit tests, which are the source
        // of truth. A pin-to-default is a no-op here too (same station ⇒ not deeper ⇒ not flagged).
        const stageOverrides = (args?.stageDropOverrides ?? []) as Array<{
          section_id: number;
          station_index: number;
        } | null>;
        const gasAtRef = (r: { section_id: number; station_index: number }) => {
          const idx = stations.findIndex(
            (s) =>
              s.station_ref.section_id === r.section_id &&
              s.station_ref.station_index === r.station_index,
          );
          return idx >= 0 ? (gas_to_reach[idx] ?? 0) : 0;
        };
        const stage_drop_over_reserve = stage_drop_refs.map((defRef, i) => {
          const ov = stageOverrides[i];
          if (ov == null || defRef == null) return false;
          const over = gasAtRef(ov) > gasAtRef(defRef);
          stage_drop_refs[i] = ov;
          return over;
        });
        // Route legs to the target (consecutive reachable stations; the real graph path is
        // exercised in Rust). is_jump stays false - the seeded e2e sections carry no jumps.
        const route =
          targetRef != null
            ? reachableRefs
                .slice(0, -1)
                .map((from, i) => ({ from, to: reachableRefs[i + 1], is_jump: false }))
            : [];

        // Route physical metrics (#236) over the route's stations, in order (origin→turnaround),
        // derived from the route legs the mock returns - so it mirrors the backend's route_refs
        // CHAIN, not the full reachable set. NOTE: the seeded e2e cave is a single linear section
        // with no merge/closure ties, so this is an approximation for the linear seed, not a
        // re-implementation of the backend's tie-aware shortest path (exact math is Rust-tested).
        const coordByRef = new Map(
          stations.map((s) => [
            `${s.station_ref.section_id}:${s.station_ref.station_index}`,
            s.coordinates,
          ]),
        );
        const routeRefsOrdered =
          route.length > 0
            ? [route[0].from, ...route.map((leg) => leg.to)]
            : targetRef != null
              ? [targetRef]
              : [];
        const routePts = routeRefsOrdered
          .map((r) => coordByRef.get(`${r.section_id}:${r.station_index}`))
          .filter((c): c is { x: number; y: number; z: number } => c != null);
        let route_line_length_m = 0;
        let route_max_depth_m: number | null = null;
        let route_avg_depth_m: number | null = null;
        if (routePts.length > 0) {
          route_max_depth_m = Math.max(...routePts.map((c) => c.z));
          let depthLenSum = 0;
          for (let i = 1; i < routePts.length; i += 1) {
            const a = routePts[i - 1];
            const b = routePts[i];
            const seg = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
            route_line_length_m += seg;
            depthLenSum += seg * 0.5 * (a.z + b.z);
          }
          route_avg_depth_m =
            route_line_length_m > 0 ? depthLenSum / route_line_length_m : routePts[0].z;
        }

        const margin = gasConfig.reserve_profile?.all_thirds_safety_margin_bar ?? 0;
        const backCyls = cylinders.filter((c) => c.role === 'back_gas' && c.enabled !== false);
        const sumWv = backCyls.reduce((s, c) => s + (c.water_volume_l ?? 0), 0);
        const frac = effective === 'two_stage' ? 1 / 6 : effective === 'one_stage' ? 1 / 4 : 1 / 3;
        // The engine's one per-cylinder gauge rule (gas.rs `in_usable_bar`, #576 A18(e)),
        // without the Z derate: the bar a cylinder spends on the way in, a share of its
        // conservative-capped basis read off its REAL gauge and clamped to [0, fill]. The
        // turn gauge, the stage drops and the usable column all derive from it, so an
        // overfilled tank reads as the engine reads it (11 L rated 207 filled 230 with a
        // 30-bar reserve drops at 230 - 88.5 = 141.5, not on the capped scale at 118.5).
        const inUsableBar = (c: (typeof cylinders)[number], stageCounted: boolean): number => {
          if (c.role !== 'back_gas' && c.role !== 'stage') return 0;
          const fill = c.fill_bar ?? 0;
          const rated = c.rated_pressure_bar ?? fill;
          const basis = gasConfig.conservative_tank_gas !== false ? Math.min(fill, rated) : fill;
          const toFill = (bar: number) => Math.max(0, Math.min(bar, fill));
          if (effective === 'free') return Math.max(0, Math.min(c.usable_gas_bar ?? 0, basis));
          // ⅓ less the safety margin, for back gas and stages alike.
          if (effective === 'all_thirds') return toFill(basis / 3 - margin);
          if (c.role === 'back_gas') return toFill(frac * basis);
          return stageCounted ? toFill(0.5 * (basis - reserve)) : 0;
        };
        // Turn gauge: the volume-weighted mean of each back-gas tank's `fill - usable`.
        const backgas_turn_bar =
          sumWv > 0
            ? Math.max(
                0,
                backCyls.reduce(
                  (s, c) => s + (c.water_volume_l ?? 0) * ((c.fill_bar ?? 0) - inUsableBar(c, false)),
                  0,
                ) / sumWv,
              )
            : null;
        // A drop reads `fill - usable` on the stage's own gauge.
        const stage_drop_bars = dropSourceStages.map((c) =>
          Math.max(0, (c.fill_bar ?? 0) - inUsableBar(c, true)),
        );
        // Cumulative swum distance to each drop ref along the route (aligned with stage_drop_refs).
        const cumDist: number[] = [];
        {
          let acc = 0;
          for (let i = 0; i < routePts.length; i += 1) {
            if (i > 0) {
              const a = routePts[i - 1];
              const b = routePts[i];
              acc += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
            }
            cumDist.push(acc);
          }
        }
        const stage_drop_distances_m = stage_drop_refs.map((d) => {
          const j = routeRefsOrdered.findIndex(
            (r) => r.section_id === d.section_id && r.station_index === d.station_index,
          );
          return j >= 0 ? (cumDist[j] ?? 0) : 0;
        });
        // Per-row usable bar (#245), aligned 1:1 with INPUT cylinders (disabled/non-budget = 0):
        // the same gauge rule as the turn and the drops. Half Minus counts only the first
        // `required` enabled stages. Rust unit tests pin the exact (Z-derated) math.
        let enabledStageI = 0;
        const cylinder_usable_bars = cylinders.map((c) => {
          if (c.enabled === false) return 0;
          const counted = c.role === 'stage' && enabledStageI++ < required;
          return inUsableBar(c, counted);
        });
        // Cumulative gas at each way point (#298). Like the drop math above this is a
        // shape-correct stand-in, not the engine's multi-leg walk: it reports each way point's
        // own gas-to-reach (null when the station is not in the field at all, which is what
        // the panel's "unreachable" warning keys off) rather than accumulating the legs. The
        // real accumulation is unit-tested in Rust; the e2e asserts UI wiring only.
        const waypointArgs = (args?.waypoints ?? []) as Array<{
          section_id: number;
          station_index: number;
        }>;
        const waypoint_gas_litres = waypointArgs.map((w) => {
          const idx = stations.findIndex(
            (s) =>
              s.station_ref.section_id === w.section_id &&
              s.station_ref.station_index === w.station_index,
          );
          return idx >= 0 ? gas_to_reach[idx] : null;
        });
        // Round-trip dive profile (#299). Same standing as the metrics above: a shape-correct
        // stand-in over the linear e2e seed, not the engine's tie-aware, asymmetrically-priced
        // walk. It does honour the one property the UI is asserted on - the exit leg is swum at
        // `swim_speed_m_per_min` while the way in uses the survey speed when one is set - so a
        // spec can tell the two axes apart. The real engine additionally rides a SCOOTERED span
        // out at the span's own pace (#317); no spec asserts the exit half's numbers, so this
        // stand-in does not model that. The exact math is pinned by the Rust tests.
        const inSpeed = gasConfig.survey_speed_m_per_min ?? gasConfig.swim_speed_m_per_min ?? 10;
        const outSpeed = gasConfig.swim_speed_m_per_min ?? 10;
        const routeGasAt = (r: { section_id: number; station_index: number }) => {
          const idx = stations.findIndex(
            (s) =>
              s.station_ref.section_id === r.section_id &&
              s.station_ref.station_index === r.station_index,
          );
          return idx >= 0 ? (gas_to_reach[idx] ?? 0) : 0;
        };
        const outboundProfile = routeRefsOrdered.map((r, i) => ({
          route_index: i,
          station_ref: r,
          distance_m: cumDist[i] ?? 0,
          depth_m: routePts[i]?.z ?? 0,
          gas_l: routeGasAt(r),
          elapsed_min: (cumDist[i] ?? 0) / inSpeed,
          outbound: true,
        }));
        const turnPoint = outboundProfile[outboundProfile.length - 1];
        const totalOut = turnPoint?.distance_m ?? 0;
        const route_profile = [...outboundProfile];
        if (turnPoint) {
          let gas = turnPoint.gas_l;
          let elapsed = turnPoint.elapsed_min;
          for (let i = outboundProfile.length - 2; i >= 0; i -= 1) {
            const seg = outboundProfile[i + 1].distance_m - outboundProfile[i].distance_m;
            elapsed += seg / outSpeed;
            // Re-swim the leg's outbound cost, scaled by the speed ratio: faster out means less
            // time at depth, hence less gas. Enough for the UI, not the engine's real pricing.
            gas +=
              (outboundProfile[i + 1].gas_l - outboundProfile[i].gas_l) * (inSpeed / outSpeed);
            route_profile.push({
              ...outboundProfile[i],
              distance_m: totalOut + (totalOut - outboundProfile[i].distance_m),
              gas_l: gas,
              elapsed_min: elapsed,
              outbound: false,
            });
          }
        }
        // ⚠ Mock-only shortcut: a REF lookup, which is exactly the ambiguity the real engine's
        // route indices exist to remove (a way-point route revisits stations, and `findIndex`
        // matches the first pass). Adequate here because the seeded e2e cave is linear, so no
        // station appears twice - but do not read this as a model of the backend.
        // NOT filtered: the real engine maps `drop_indices` straight through, so this array is
        // always the same length as `stage_drop_refs` / `stage_drop_over_reserve`, and the
        // consumer indexes all three positionally. Dropping a miss would shift every later
        // entry and silently pin an over-reserve flag to the wrong stage. A miss surfaces as a
        // visibly wrong -1 instead, which is the direction a mock should fail in.
        const stage_drop_route_indices = stage_drop_refs.map((d) =>
          routeRefsOrdered.findIndex(
            (r) => r.section_id === d.section_id && r.station_index === d.station_index,
          ),
        );
        const waypoint_route_indices = waypointArgs.map((w) => {
          const j = routeRefsOrdered.findIndex(
            (r) => r.section_id === w.section_id && r.station_index === w.station_index,
          );
          return j >= 0 ? j : null;
        });
        // Scooter + per-segment readouts (#317). Same standing caveat as the drop math above:
        // a shape-correct stand-in for UI wiring, NOT the engine's rule. In particular the mock
        // does NOT enforce the range cap on `reachable` / `turn_frontier` - the engine ANDs it
        // into both masks, and the Rust unit tests are the source of truth for that. So an e2e
        // here may assert that the readout rows render the numbers it was handed; it may NOT
        // assert which stations grey out under a rig.
        //
        // With no rig (`dpv: null`, which is what both mock config blocks ship) every value
        // below is inert, so the 31 existing gas specs - all calibrated against the fixed
        // 1500 L budget and `|x| * 20` field - are untouched.
        const segmentArgs = (args?.segments ?? []) as Array<{
          speed_m_per_min?: number | null;
          on_scooter?: boolean;
        }>;
        const rig = gasConfig.dpv ?? null;
        const unitRange = (u?: { speed_m_per_min?: number; burn_minutes?: number }) =>
          (u?.speed_m_per_min ?? 0) * (u?.burn_minutes ?? 0);
        // Twin of `MAX_DPV_RANGE_RESERVE_FRACTION` (src-tauri/src/config/gas.rs) and its
        // frontend mirror (`MAX_DPV_RANGE_RESERVE_FRACTION` in GasSettings.tsx) - both clamp
        // the reserve fraction to [0, 0.9] before applying it.
        const clampedReserveFraction = Math.min(
          0.9,
          Math.max(0, rig?.range_reserve_fraction ?? 0),
        );
        const scooter_range_limit_m = rig
          ? Math.max(
              0,
              Math.min(unitRange(rig.primary), unitRange(rig.backup)) *
                (1 - clampedReserveFraction),
            )
          : null;
        // Which segment each route leg belongs to: way points split the route, so leg j sits in
        // the segment named by how many way points the route has already passed at that point.
        const routeIndexOf = (r: { section_id: number; station_index: number }) =>
          routeRefsOrdered.findIndex(
            (x) => x.section_id === r.section_id && x.station_index === r.station_index,
          );
        const waypointRouteIdx = waypointArgs.map(routeIndexOf).filter((i) => i >= 0);
        const segmentAtLeg = (legIdx: number) =>
          waypointRouteIdx.filter((wi) => wi <= legIdx).length;
        // Twin of `MIN_SEGMENT_SPEED_M_PER_MIN`/`MAX_SEGMENT_SPEED_M_PER_MIN` in gas/scooter.rs
        // ([0.1, 1000] m/min) - the engine falls back to the plan speed outside this range
        // rather than accepting whatever was stored, and the mock must refuse the same values
        // or an e2e asserting an out-of-range speed's effect could pass against the mock while
        // diverging from the backend.
        const isSegmentSpeedInRange = (v: number | null | undefined): v is number =>
          typeof v === 'number' && v >= 0.1 && v <= 1000;
        let scooter_distance_m = 0;
        let route_runtime_min: number | null = null;
        if (routePts.length > 1) {
          let minutes = 0;
          for (let i = 1; i < routePts.length; i += 1) {
            const a = routePts[i - 1];
            const b = routePts[i];
            const seg = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
            const s = segmentArgs[segmentAtLeg(i - 1)];
            // A span with no speed of its own is flown at the PLAN's speed, not a hardcoded
            // one - mirroring `resolve_segments` (gas/scooter.rs). Getting this wrong is how
            // the real engine once stopped honouring the configured swim speed entirely.
            const speed = isSegmentSpeedInRange(s?.speed_m_per_min) ? s.speed_m_per_min : inSpeed;
            minutes += seg / speed;
            if (rig && s?.on_scooter) scooter_distance_m += seg;
          }
          route_runtime_min = minutes;
        }
        // The park point is DERIVED, never placed: the boundary after the last scootered
        // segment. Null when nothing is scootered, and when the units are carried all the way
        // to the turnaround (the last segment is scootered, so its boundary is the turn).
        let scooter_drop_ref: { section_id: number; station_index: number } | null = null;
        if (rig) {
          let lastOn = -1;
          for (let i = 0; i < segmentArgs.length; i += 1) {
            if (segmentArgs[i]?.on_scooter) lastOn = i;
          }
          if (lastOn >= 0 && lastOn + 1 < segmentArgs.length) {
            scooter_drop_ref = waypointArgs[lastOn] ?? null;
          }
        }
        // NOT `scooter_distance_m > scooter_range_limit_m` - that is verbatim the naive
        // per-route comparison `GasReachField::turn_on_scooter_range`'s own doc
        // (models/project/gas/model.rs) says the UI must not re-derive: the route already
        // stops at whichever cap bound first, so the two read as merely equal in exactly
        // the case being asked about. No spec asserts this value; hardcoded false rather
        // than guess at the real (cave-scoped) rule.
        const turn_on_scooter_range = false;
        return {
          station_refs: stations.map((s) => s.station_ref),
          gas_to_reach,
          reachable,
          turn_frontier,
          max_reachable_gas,
          budget_litres,
          route,
          stage_drop_refs,
          final_turn_ref,
          turn_toward_endpoint,
          backgas_turn_bar,
          stage_drop_bars,
          stage_drop_over_reserve,
          stage_drop_distances_m,
          cylinder_usable_bars,
          route_line_length_m,
          route_max_depth_m,
          route_avg_depth_m,
          waypoint_gas_litres,
          route_profile,
          stage_drop_route_indices,
          waypoint_route_indices,
          scooter_distance_m,
          scooter_range_limit_m,
          scooter_drop_ref,
          route_runtime_min,
          turn_on_scooter_range,
        };
      }

      default:
        return ctx.unhandled;
    }
  };
};
