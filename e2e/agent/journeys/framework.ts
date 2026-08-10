/**
 * Journey framework (#466). A Journey is a LINEAR golden flow over the real app
 * with explicit behavioral expectations - unlike a stress Scenario, which is a
 * seeded loop whose gate is "did not crash". Journeys reuse ScenarioContext for
 * every app primitive and add two things:
 *
 * - `expect(label, ok, detail)`: records a pass/fail CHECK instead of throwing,
 *   so one breach does not hide the rest; the runner fails the journey if any
 *   check failed. A journey may still throw for a step that makes continuing
 *   meaningless (e.g. the project would not load).
 * - `checkpoint(name)`: drops a screenshot into the session artifacts as
 *   EVIDENCE for the verdict record. Checkpoints never gate - store and disk
 *   state do (no pixel-golden flakiness).
 *
 * Journeys must not hardcode expectations derived from the CONTENT of local
 * fixtures (`e2e/fixtures/` is user-managed and never committed): derive the
 * expected values at runtime (e.g. from `parseTml`) or from data the journey
 * itself constructs.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { ScenarioContext, ScenarioTarget } from '../scenarios/framework';
import { makeContext } from '../scenarios/framework';

export interface JourneyCheck {
  label: string;
  ok: boolean;
  /** Shown on failure: what was expected vs observed. */
  detail?: string;
}

export interface JourneyContext extends ScenarioContext {
  /** Record a behavioral check. Returns `ok` so callers can branch on it. */
  expect(label: string, ok: boolean, detail?: string): boolean;
  /** Screenshot evidence into the session artifacts (never gates). */
  checkpoint(name: string): Promise<void>;
  readonly checks: JourneyCheck[];
}

export interface Journey {
  name: string;
  description: string;
  run(ctx: JourneyContext): Promise<void>;
}

export interface JourneyResult {
  journey: string;
  verdict: 'pass' | 'fail';
  durationMs: number;
  checks: JourneyCheck[];
  /** Message of a thrown abort, when the journey did not run to completion. */
  aborted?: string;
}

export function makeJourneyContext(
  target: ScenarioTarget,
  journeyName: string,
  onLog?: (message: string) => void,
): JourneyContext {
  // Journeys are deterministic flows; the seed only feeds helpers that want a
  // ScenarioContext. Fixed at 1 so any randomized helper draw is reproducible.
  const base = makeContext(target, 1, onLog);
  const checks: JourneyCheck[] = [];
  const shotsDir = base.artifactsDir ? path.join(base.artifactsDir, 'journeys', journeyName) : null;
  return {
    ...base,
    checks,
    expect(label, ok, detail) {
      checks.push(ok ? { label, ok } : { label, ok, detail });
      base.log(`${ok ? 'ok' : 'FAIL'}: ${label}${!ok && detail ? ` - ${detail}` : ''}`);
      return ok;
    },
    async checkpoint(name) {
      if (!shotsDir) return;
      // Checkpoints are evidence and must NEVER gate: a screenshot failure
      // (WebDriver backend quirk, platform permission) is logged, not thrown -
      // letting it escape would abort a behaviorally passing journey.
      try {
        fs.mkdirSync(shotsDir, { recursive: true });
        const file = path.join(shotsDir, `${name}.png`);
        await target.exclusive(() => target.browser.saveScreenshot(file));
        base.log(`checkpoint ${name} -> ${file}`);
      } catch (err) {
        base.log(`checkpoint ${name} FAILED (non-gating): ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

export async function runJourney(
  journey: Journey,
  target: ScenarioTarget,
  onLog?: (message: string) => void,
): Promise<JourneyResult> {
  const ctx = makeJourneyContext(target, journey.name, onLog);
  const start = Date.now();
  let aborted: string | undefined;
  try {
    await journey.run(ctx);
  } catch (err) {
    aborted = err instanceof Error ? err.message : String(err);
  }
  // A journey that recorded no checks asserted nothing - a silent PASS from a
  // spec whose early guards all bailed is exactly the vacuous-test defect the
  // review contract exists to catch. Fail it.
  if (aborted === undefined && ctx.checks.length === 0) {
    aborted = 'journey recorded zero checks - a journey must assert something';
  }
  const failed = aborted !== undefined || ctx.checks.some((c) => !c.ok);
  return {
    journey: journey.name,
    verdict: failed ? 'fail' : 'pass',
    durationMs: Date.now() - start,
    checks: ctx.checks,
    ...(aborted !== undefined ? { aborted } : {}),
  };
}
