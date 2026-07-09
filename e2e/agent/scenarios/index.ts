/**
 * Scenario registry + runner. `runScenario` builds a seeded ScenarioContext
 * bound to the live session and runs the named scenario, returning its metrics.
 * The caller (the run_scenario MCP tool) does a full oracle sweep afterwards.
 */
import { makeContext, type Scenario, type ScenarioMetrics, type ScenarioTarget } from './framework';
import { seedLargeProject } from './seedLargeProject';
import { undoRedoChurn } from './undoRedoChurn';
import { dialogCycling } from './dialogCycling';
import { toolSwitchSpam } from './toolSwitchSpam';
import { mapStorm } from './mapStorm';
import { saveUnderChurn } from './saveUnderChurn';
import { importRepeatedly } from './importRepeatedly';
import { rapidProjectCycle } from './rapidProjectCycle';

const SCENARIOS: Scenario[] = [
  seedLargeProject,
  undoRedoChurn,
  dialogCycling,
  toolSwitchSpam,
  mapStorm,
  saveUnderChurn,
  importRepeatedly,
  rapidProjectCycle,
];

const REGISTRY: Record<string, Scenario> = Object.fromEntries(SCENARIOS.map((s) => [s.name, s]));

export function listScenarios(): string[] {
  return Object.keys(REGISTRY).sort();
}

export function getScenario(name: string): Scenario | undefined {
  return REGISTRY[name];
}

export interface RunScenarioOpts {
  seed?: number;
  iterations?: number;
  log?: (message: string) => void;
}

export async function runScenario(
  name: string,
  target: ScenarioTarget,
  opts: RunScenarioOpts = {},
): Promise<ScenarioMetrics> {
  const scenario = REGISTRY[name];
  if (!scenario) {
    throw new Error(`unknown scenario "${name}"; known: ${listScenarios().join(', ') || '(none)'}`);
  }
  const seed = opts.seed ?? 1;
  const iterations = opts.iterations ?? scenario.defaultIterations;
  const ctx = makeContext(target, seed, opts.log);
  ctx.log(`scenario ${name} start (seed=${seed}, iterations=${iterations})`);
  const start = Date.now();
  await scenario.run(ctx, { iterations });
  const durationMs = Date.now() - start;
  ctx.log(`scenario ${name} done in ${durationMs}ms`);
  return { scenario: name, seed, iterations, durationMs, metrics: ctx.metrics };
}
