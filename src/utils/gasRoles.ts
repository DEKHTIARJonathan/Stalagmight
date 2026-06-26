import type { CylRole } from '../types/ipc.generated';

/**
 * Roles whose gas counts toward the open-circuit penetration budget (PRD §5.3):
 * back gas and stage. Deco/dil-out/bailout are excluded from the swim-in budget.
 * Shared by the Plan-setup readout (turn pressure) and the Cylinders table (which
 * dims non-budget rows). (#38)
 */
export function isBudgetRole(role: CylRole): boolean {
  return role === 'back_gas' || role === 'stage';
}
