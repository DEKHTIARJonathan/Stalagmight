import { describe, expect, it, vi } from 'vitest';
import { registerOnboardingRestart, restartOnboardingProgress } from '../useOnboardingRestart';

describe('useOnboardingRestart: the Settings > Restart onboarding wiring (#368)', () => {
  it('is a no-op when nothing is registered (e.g. before App mounts, or in a stale unmount race)', () => {
    registerOnboardingRestart(null);
    expect(() => restartOnboardingProgress()).not.toThrow();
  });

  it('calls the registered clear function on trigger', () => {
    const clear = vi.fn();
    registerOnboardingRestart(clear);
    restartOnboardingProgress();
    expect(clear).toHaveBeenCalledTimes(1);
    registerOnboardingRestart(null);
  });

  it('un-registering (App unmount) makes a later trigger a no-op again', () => {
    const clear = vi.fn();
    registerOnboardingRestart(clear);
    registerOnboardingRestart(null);
    restartOnboardingProgress();
    expect(clear).not.toHaveBeenCalled();
  });
});
