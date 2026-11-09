/** Recovery may replace the upload dialog. Reopening requires user confirmation. */
let continuation: { path: string; message: string; closeAfterSave: boolean } | null = null;
export function getUploadContinuation(path: string | null | undefined) {
  if (continuation?.path !== path) continuation = null;
  return continuation;
}
export function setUploadContinuation(value: typeof continuation) { continuation = value; }
