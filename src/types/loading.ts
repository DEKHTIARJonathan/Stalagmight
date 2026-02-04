/**
 * Loading progress types generated from Rust IPC models.
 */

import type { LoadingProgress } from './ipc.generated';

export type {
  DisplaySettings,
  LoadingPhase,
  LoadProjectFullResult,
  CreateProjectFullResult,
} from './ipc.generated';

export type LoadingProgressPayload = LoadingProgress;
