/**
 * Coordinate whole-project switches with in-place SpeleoDB tree replacements.
 * Existing switches finish before a replacement starts; switches requested during
 * the replacement wait until its frontend reconciliation is complete.
 *
 * [#576 D23] A switch also waits for the edits queued BEFORE it
 * (`mutationsSettled`): edits run on their own queue (`runSerialized`), and one
 * still waiting there when the user opened another project used to reach the
 * backend after the switch and run against the new project, where the same small
 * section and shot ids mostly resolve. Edits issued DURING a switch are not held
 * back by it; the identity guards (`lostProject`, `projectSwitched`) still refuse
 * those.
 */
import { mutationsSettled } from '../store/mutationQueue';

let replacementTail: Promise<void> = Promise.resolve();
let switchTail: Promise<void> = Promise.resolve();

export function runProjectSwitch<T>(work: () => Promise<T>): Promise<T> {
  const editsIssuedBefore = mutationsSettled();
  const result = Promise.all([replacementTail, editsIssuedBefore]).then(() => work());
  switchTail = Promise.allSettled([switchTail, result]).then(() => undefined);
  return result;
}

export function runTreeReplacement<T>(work: () => Promise<T>): Promise<T> {
  const previousReplacement = replacementTail;
  const switchesAlreadyIssued = switchTail;
  let releaseReplacement!: () => void;
  const replacementFinished = new Promise<void>((resolve) => {
    releaseReplacement = resolve;
  });

  replacementTail = previousReplacement.then(() => replacementFinished);
  return (async () => {
    await previousReplacement;
    await switchesAlreadyIssued;
    try {
      return await work();
    } finally {
      releaseReplacement();
    }
  })();
}
