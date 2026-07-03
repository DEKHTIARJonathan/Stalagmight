/**
 * WebdriverIO config for running generated agent replay specs. Spreads the base
 * wdio.conf.ts (same tauri-driver launch, env isolation, Xvfb fallback, and
 * capabilities) and overrides only what a replay needs: a single instance, no
 * retries (a replay must be deterministic), and the spec chosen by REPLAY_SPEC.
 *
 *   REPLAY_SPEC=e2e/agent/replays/repro.spec.ts pnpm test:e2e:replay
 *
 * With no REPLAY_SPEC, runs everything under e2e/agent/replays/.
 */
import { config as baseConfig } from './wdio.conf';

export const config: typeof baseConfig = {
  ...baseConfig,
  specs: [process.env.REPLAY_SPEC || './e2e/agent/replays/**/*.spec.ts'],
  maxInstances: 1,
  specFileRetries: 0,
};
