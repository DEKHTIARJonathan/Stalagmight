/**
 * Shared scenario helpers. Fixture-path resolution, project seeding, a cheap
 * deterministic state signature, and a valid minimal SectionData factory (shapes
 * verified against src/types/ipc/{SectionData,ShotData}.ts).
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { ScenarioContext } from './framework';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export const DEFAULT_FIXTURE = 'fractal_plant_iter2.stalx';

export function fixturePath(name: string): string {
  // Confine to a basename so a caller-supplied name cannot resolve outside
  // e2e/fixtures/ (the seed tool passes this through verbatim).
  return path.join(repoRoot, 'e2e', 'fixtures', path.basename(name));
}

export async function hasProject(ctx: ScenarioContext): Promise<boolean> {
  return ctx.eval<boolean>('return !!window.__E2E_TEST__.projectStore.getState().project;');
}

/** Open a fixture project if none is loaded (openProject also switches to single view). */
export async function ensureProjectLoaded(ctx: ScenarioContext, fixture = DEFAULT_FIXTURE): Promise<void> {
  if (await hasProject(ctx)) return;
  const p = fixturePath(fixture);
  if (!fs.existsSync(p)) throw new Error(`fixture missing: ${p}`);
  const res = (await ctx.callAction('project', 'openProject', [p])) as {
    ok: boolean;
    error?: string;
    result?: { success?: boolean; error?: string };
  };
  if (!res.ok || res.result?.success === false) {
    throw new Error(`openProject failed: ${res.result?.error ?? res.error ?? 'unknown'}`);
  }
  if (!(await hasProject(ctx))) throw new Error('project still null after openProject');
}

/** A valid minimal section (two standard shots), unique per index. */
export function makeSection(i: number): Record<string, unknown> {
  const shot = (az: number, len: number, dIn: number, dOut: number) => ({
    azimuth_in: az,
    azimuth_out: az,
    length: len,
    depth_in: dIn,
    depth_out: dOut,
    pitch_in: null,
    pitch_out: null,
    left: 1,
    right: 1,
    up: 1,
    down: 1,
    comment: null,
    kind: 'Normal',
    marker_index: null,
    temperature: null,
  });
  return {
    name: `harness-churn-${i}`,
    surveyor: 'harness',
    date: '2026-01-01',
    color: '#3388FF',
    direction: 'out',
    quality: 3,
    shots: [shot(0, 5, 0, 1), shot(90, 4, 1, 2)],
  };
}

/** Cheap deterministic signature of mutable project state (for undo/redo equality). */
export async function stateSignature(ctx: ScenarioContext): Promise<string> {
  return ctx.eval<string>(`
    const p = window.__E2E_TEST__.projectStore.getState().project;
    if (!p) return 'null';
    const sections = (p.sections || []).map(s => (s.name || '') + '#' + (s.shots ? s.shots.length : 0));
    return JSON.stringify({ sections, merges: (p.station_merges || []).length });
  `);
}

/** getUndoStack().length (async IPC round-trip). */
export async function undoDepth(ctx: ScenarioContext): Promise<number> {
  const res = (await ctx.callAction('project', 'getUndoStack', [])) as { ok: boolean; result?: unknown[] };
  return Array.isArray(res.result) ? res.result.length : 0;
}
