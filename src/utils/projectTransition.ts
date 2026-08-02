/**
 * Coordinate whole-project switches with in-place SpeleoDB tree replacements.
 * Existing switches finish before a replacement starts; switches requested during
 * the replacement wait until its frontend reconciliation is complete.
 */
let replacementTail: Promise<void> = Promise.resolve();
let switchTail: Promise<void> = Promise.resolve();

export function runProjectSwitch<T>(work: () => Promise<T>): Promise<T> {
  const result = replacementTail.then(work);
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
