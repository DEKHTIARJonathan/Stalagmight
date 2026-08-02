import { useGasPlanStore } from '../store/gasPlanStore';
import { useProjectStore } from '../store/projectStore';
import {
  speleoProjectSessionStillCurrent,
  type SpeleoProjectSessionIdentity,
  useSpeleoStore,
} from '../store/speleoStore';
import { useUIStore } from '../store/uiStore';

/**
 * Reconcile every frontend store after the backend replaces the open survey tree in place.
 * Returns false when the request belongs to a project or login session that is no longer current.
 */
export async function applySpeleoTreeReplacement(
  issuedFor?: SpeleoProjectSessionIdentity,
): Promise<boolean> {
  if (issuedFor && !speleoProjectSessionStillCurrent(issuedFor)) return false;

  const ui = useUIStore.getState();
  ui.clearSelection();
  ui.resetToolTransientsForProjectSwitch();
  useGasPlanStore.getState().reset();
  ui.setView('single');

  await useProjectStore.getState().refreshProjectState();
  if (issuedFor && !speleoProjectSessionStillCurrent(issuedFor)) return false;

  useProjectStore.setState({ isDirty: false });
  void useProjectStore.getState().checkProjectIntegrity();
  await useSpeleoStore.getState().refreshLinkStatus();
  return !issuedFor || speleoProjectSessionStillCurrent(issuedFor);
}
