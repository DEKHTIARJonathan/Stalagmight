import { useEffect, useRef, useState } from 'react';
import { useProjectStore } from '../../store/projectStore';
import { useSpeleoStore } from '../../store/speleoStore';
import { defaultConfig } from '../../types/config';
import { SpeleoDbSettings } from '../Dialogs/settings/SpeleoDbSettings';
import { Button } from '../common/Button';
import { registerWorkspaceDraft } from '../../utils/workspaceDrafts';
import { endpointsMatch } from '../../utils/speleoEndpoint';

/** Uses the same staged account implementation as Home settings. */
export function SpeleoWorkspaceAccount() {
  const busy = useSpeleoStore((s) => s.busy);
  const saved = useProjectStore((s) => s.config) ?? defaultConfig;
  const [connection, setConnection] = useState(saved.speleodb);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const baseline = useRef(saved.speleodb);
  const dirty = connection.endpoint !== baseline.current.endpoint ||
    connection.insecure_http !== baseline.current.insecure_http;
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    // Refresh clean forms only; passive authentication loss must retain a draft.
    if (!dirty) {
      baseline.current = saved.speleodb;
      setConnection(saved.speleodb);
    }
  }, [saved.speleodb, dirty]);
  const state = useRef({ dirty, saved, saving, connection });
  state.current = { dirty, saved, saving, connection };
  useEffect(() => registerWorkspaceDraft({
    dirty: () => state.current.dirty && !state.current.saving,
    discard: () => {
      baseline.current = state.current.saved.speleodb;
      setConnection(state.current.saved.speleodb);
    },
  }), []);
  const apply = async () => {
    if (useSpeleoStore.getState().busy) return;
    let generation = useSpeleoStore.getState().sessionGeneration;
    const initialSession = useSpeleoStore.getState().session;
    const pendingAuth = useSpeleoStore.getState().pendingAuth;
    const submitted = connection;
    const current = () => mounted.current && useSpeleoStore.getState().sessionGeneration === generation;
    const busyToken = useSpeleoStore.getState().beginBusy();
    setSaving(true);
    state.current.saving = true;
    setError(null);
    try {
      const store = useProjectStore.getState();
      const result = await store.updateConfig({ ...(store.config ?? defaultConfig), speleodb: {
        ...(store.config ?? defaultConfig).speleodb,
        endpoint: connection.endpoint, insecure_http: connection.insecure_http,
      } });
      if (!result.success) { if (current() && result.error !== 'Cancelled') setError(result.error ?? 'Could not apply connection settings'); return; }
      // Applying a different endpoint deliberately ends the old session once.
      const after = useSpeleoStore.getState();
      if (initialSession?.loggedIn && !endpointsMatch(initialSession.endpoint, submitted.endpoint) &&
          after.sessionGeneration === generation + 1 && !after.session && after.pendingAuth === pendingAuth) {
        generation = after.sessionGeneration;
      }
      if (!current()) return;
      const applied = useProjectStore.getState().config?.speleodb ?? submitted;
      baseline.current = applied;
      if (state.current.connection === submitted) setConnection(applied);
      const auth = await useSpeleoStore.getState().applyPendingAuth(connection.endpoint);
      if (auth.cancelled || !current()) return;
      if (!auth.ok) setError(String(auth.error));
    } finally { useSpeleoStore.getState().endBusy(busyToken); state.current.saving = false; if (mounted.current) setSaving(false); }
  };
  return (
    <div className="space-y-3" data-testid="speleodb-workspace-account">
      <SpeleoDbSettings config={{ ...saved, speleodb: connection }}
        onChange={(patch) => { if (patch.speleodb) setConnection(patch.speleodb); }}
        changedFields={new Set(dirty ? ['speleodb.endpoint', 'speleodb.insecure_http'] : [])}
        onValidationError={() => {}} panelIdBase="workspace-account" embedded isApplying={() => state.current.saving} />
      {error && <p role="alert" className="text-error text-sm">{error}</p>}
      <Button onClick={() => void apply()} disabled={saving || busy} data-testid="speleodb-workspace-apply-connection">
        Apply account & connection settings
      </Button>
    </div>
  );
}
