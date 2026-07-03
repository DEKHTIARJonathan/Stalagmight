// Moved to e2e/lib/fractal.ts so both the wdio suite and the agent harness can
// share the L-system generator. Re-exported here so the existing legacy specs
// keep importing from their original path.
export * from '../../lib/fractal';
