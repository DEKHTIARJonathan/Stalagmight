import type { TFunction } from 'i18next';
import { formatFixed } from '../i18n/format';
import type { Cylinder, Diver, GasConfig } from '../types/ipc.generated';
import { rmvToDisplay } from './formatGas';

/**
 * One-line "what am I assuming" summary for the R9/R10 entry card's collapsed assumptions
 * disclosure (#395): RMV, cylinder count x type, gas strategy - always derived LIVE from the
 * working store, never hardcoded, so it can never drift from what "Adjust assumptions" reveals.
 */
export function gasAssumptionsSummary(
  diver: Diver,
  cylinders: Cylinder[],
  gasConfig: GasConfig,
  t: TFunction
): string {
  const units = gasConfig.units;
  const rmv = formatFixed(
    rmvToDisplay(diver.rmv_l_per_min, units),
    undefined,
    units === 'imperial' ? 2 : 1
  );
  const rmvUnit = t(units === 'imperial' ? 'gasPanel.diver.rmvUnitImperial' : 'gasPanel.diver.rmvUnit');
  const strategy = t(`gasPanel.reserve.${gasConfig.default_reserve}`);
  return `${rmv} ${rmvUnit} · ${summarizeCylinders(cylinders)} · ${strategy}`;
}

/** "2x AL80" for a matched set, "1x AL80 + 1x AL40" for a mixed rig, "0" for none. */
function summarizeCylinders(cylinders: Cylinder[]): string {
  if (cylinders.length === 0) return '0';
  const counts = new Map<string, number>();
  for (const c of cylinders) {
    const name = c.label ?? `${c.water_volume_l}L`;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()].map(([name, n]) => `${n}x ${name}`).join(' + ');
}
