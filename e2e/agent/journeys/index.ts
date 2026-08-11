/** Journey registry (#466). Linear golden flows; see framework.ts. */
import type { Journey } from './framework';
import { importTml } from './importTml';
import { saveReopen } from './saveReopen';
import { exportTmlRoundtrip } from './exportTmlRoundtrip';
import { newProjectFromDmp } from './newProjectFromDmp';
import { createProjectSingleWrite } from './createProjectSingleWrite';

const JOURNEYS: Journey[] = [
  importTml,
  saveReopen,
  exportTmlRoundtrip,
  newProjectFromDmp,
  createProjectSingleWrite,
];

const REGISTRY: Record<string, Journey> = Object.fromEntries(JOURNEYS.map((j) => [j.name, j]));

export function listJourneys(): string[] {
  return Object.keys(REGISTRY).sort();
}

export function getJourney(name: string): Journey | undefined {
  return REGISTRY[name];
}
