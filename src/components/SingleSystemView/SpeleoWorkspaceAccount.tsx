import { useEffect, useRef, useState } from 'react';
import { useProjectStore } from '../../store/projectStore';
import { useSpeleoStore } from '../../store/speleoStore';
import { defaultConfig } from '../../types/config';
import { SpeleoDbSettings } from '../Dialogs/settings/SpeleoDbSettings';
import { Button } from '../common/Button';
import { registerWorkspaceDraft } from '../../utils/workspaceDrafts';

/** Uses the same staged account implementation as Home settings. */
export function SpeleoWorkspaceAccount() {
  const busy = useSpeleoStore((s) => s.busy);
  const saved = useProjectStore((s) => s.config) ?? defaultConfig;
  const [connection, setConnection] = useState(saved.speleodb);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(connection) !== JSON.stringify(saved.speleodb);
  const state = useRef({ dirty, saved, saving });
  state.current = { dirty, saved, saving };
  useEffect(() => registerWorkspaceDraft({
    dirty: () => state.current.dirty && !state.current.saving,
    discard: () => setConnection(state.current.saved.speleodb),
  }), []);
  const apply = async () => {
    if (useSpeleoStore.getState().busy) return;
    const busyToken = useSpeleoStore.getState().beginBusy();
    setSaving(true);
    state.current.saving = true;
    setError(null);
    try {
      const store = useProjectStore.getState();
      const result = await store.updateConfig({ ...(store.config ?? defaultConfig), speleodb: connection });
      if (!result.success) { if (result.error !== 'Cancelled') setError(result.error ?? 'Could not apply connection settings'); return; }
      const auth = await useSpeleoStore.getState().applyPendingAuth(connection.endpoint);
      if (auth.cancelled) return;
      if (!auth.ok) setError(String(auth.error));
      else setConnection(useProjectStore.getState().config?.speleodb ?? connection);
    } finally { useSpeleoStore.getState().endBusy(busyToken); state.current.saving = false; setSaving(false); }
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
