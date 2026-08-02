/** Encode arbitrary user or filesystem values before embedding them in a test ID. */
export function testIdPart(value: string | number): string {
  return encodeURIComponent(String(value));
}

export function systemCardTestId(filePath: string): string {
  return `system-card-${testIdPart(filePath)}`;
}

export function systemRowTestId(filePath: string): string {
  return `system-row-${testIdPart(filePath)}`;
}

export function missingSystemCardTestId(filePath: string): string {
  return `system-card-missing-${testIdPart(filePath)}`;
}

export function missingSystemCardRemoveTestId(filePath: string): string {
  return `system-card-missing-remove-${testIdPart(filePath)}`;
}

export function missingSystemRowTestId(filePath: string): string {
  return `system-row-missing-${testIdPart(filePath)}`;
}

export function gasCylinderRowTestId(index: number): string {
  return `gas-cylinder-row-${index}`;
}

export function recoveryBackupItemTestId(index: number): string {
  return `recovery-backup-item-${index}`;
}

export interface WarningTestIdIdentity {
  sectionId: number;
  shotId: number;
  code: string;
  datumStationIndex?: number;
}

export function warningKey(warning: WarningTestIdIdentity): string {
  const datum = warning.datumStationIndex === undefined ? '' : `:d${warning.datumStationIndex}`;
  return `${warning.sectionId}:${warning.shotId}:${warning.code}${datum}`;
}

export function warningResolveTestId(warning: WarningTestIdIdentity): string {
  return `warning-${testIdPart(warningKey(warning))}-resolve`;
}

export function warningUndoResolveTestId(warning: WarningTestIdIdentity): string {
  return `warning-${testIdPart(warningKey(warning))}-undo-resolve`;
}
