// Playwright reporter that records per-test cost, split into hook vs body time.
//
// Why a custom reporter: the built-in `json` reporter does NOT emit `steps`, so a
// json report can tell you a test took 6s but not whether 5s of that was the
// beforeEach. Splitting those is the whole question when deciding what to keep in
// the @smoke subset - a suite that is slow because of per-test setup should be
// fixed, not cut, because cutting tests does nothing about the setup cost paid by
// the survivors. `onStepEnd` gives us `category: 'hook'` durations.
//
// Usage:
//   pnpm exec playwright test --reporter=./scripts/pw-timing-reporter.mjs
//   (compose with others: --reporter=github,./scripts/pw-timing-reporter.mjs)
//
// Output path comes from PW_TIMING_OUTPUT (default: playwright-report/timing.json).
// Render it with scripts/pw-timing-summary.mjs.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export default class TimingReporter {
  constructor() {
    /** @type {Map<string, {before:number, after:number}>} keyed by test id + retry */
    this.hooks = new Map();
    this.rows = [];
    this.startedAt = 0;
  }

  onBegin() {
    this.startedAt = Date.now();
  }

  #key(test, result) {
    return `${test.id}#${result.retry}`;
  }

  onStepEnd(test, result, step) {
    if (step.category !== 'hook') return;
    const k = this.#key(test, result);
    const e = this.hooks.get(k) ?? { before: 0, after: 0 };
    // Playwright titles these "Before Hooks" / "After Hooks". Only top-level hook
    // steps are counted; nested steps are already inside the parent's duration.
    if (step.parent?.category === 'hook') return;
    if (/^After/i.test(step.title)) e.after += step.duration ?? 0;
    else e.before += step.duration ?? 0;
    this.hooks.set(k, e);
  }

  onTestEnd(test, result) {
    const h = this.hooks.get(this.#key(test, result)) ?? { before: 0, after: 0 };
    this.rows.push({
      file: test.location.file.split('/').pop(),
      line: test.location.line,
      title: test.title,
      duration: result.duration ?? 0,
      before: h.before,
      after: h.after,
      status: result.status,
      retry: result.retry,
    });
  }

  onEnd(result) {
    // Collapse retries into one row per test, charging all attempts (that is what
    // CI actually spends).
    const merged = new Map();
    for (const r of this.rows) {
      const k = `${r.file}:${r.line}:${r.title}`;
      const e = merged.get(k) ?? { ...r, duration: 0, before: 0, after: 0, attempts: 0 };
      e.duration += r.duration;
      e.before += r.before;
      e.after += r.after;
      e.attempts += 1;
      e.status = r.status;
      merged.set(k, e);
    }
    const out = {
      stats: {
        duration: result.duration ?? Date.now() - this.startedAt,
        status: result.status,
        tests: merged.size,
      },
      tests: [...merged.values()],
    };
    const path = process.env.PW_TIMING_OUTPUT || 'playwright-report/timing.json';
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(out, null, 2));
    console.log(`\n[pw-timing] wrote ${merged.size} test timings to ${path}`);
  }
}
