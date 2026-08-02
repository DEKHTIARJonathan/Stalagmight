/** Encode arbitrary user or filesystem values before embedding them in a test ID. */
export function testIdPart(value: string | number): string {
  return encodeURIComponent(String(value));
}
