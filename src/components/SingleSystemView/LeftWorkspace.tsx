import { useRef } from 'react';
import { useUIStore } from '../../store/uiStore';
import { SpeleoWorkspace } from './SpeleoWorkspace';
import { SpeleoNetworkBusyIndicator } from './SpeleoNetworkBusyIndicator';
import type { ReactNode } from 'react';

export function LeftWorkspace({ sections }: { sections: ReactNode }) {
  const tab = useUIStore((s) => s.leftWorkspace);
  const mode = useUIStore((s) => s.appMode);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const tabs = mode === 'survey' ? ['sections', 'speleodb'] as const : ['speleodb'] as const;
  const choose = useUIStore((s) => s.selectLeftWorkspace);
  return (
    <div className="h-full min-h-0 flex flex-col">
      <div role="tablist" aria-label="Project workspace" className="flex shrink-0 border-b border-border">
        {tabs.map((id, index) => <button key={id} ref={(el) => { refs.current[index] = el; }}
          id={`workspace-tab-${id}`} role="tab" type="button" aria-selected={tab === id}
          aria-controls={`workspace-panel-${id}`} tabIndex={tab === id ? 0 : -1}
          data-testid={`workspace-tab-${id}`} onClick={() => choose(id)}
          onKeyDown={(event) => {
            const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
            if (next === null) return;
            event.preventDefault(); const nextTab = tabs[next]; if (nextTab) choose(nextTab); refs.current[next]?.focus();
          }}
          className={`flex-1 px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${tab === id ? 'bg-accent-10 font-medium' : 'text-text-secondary'}`}>
          {id === 'speleodb' ? 'SpeleoDB' : 'Sections'}
          {id === 'speleodb' && <SpeleoNetworkBusyIndicator />}
        </button>)}
      </div>
      <div role="tabpanel" id="workspace-panel-sections" aria-labelledby="workspace-tab-sections" hidden={mode !== 'survey' || tab !== 'sections'} className="flex-1 min-h-0">{sections}</div>
      <div role="tabpanel" id="workspace-panel-speleodb" aria-labelledby="workspace-tab-speleodb" hidden={tab !== 'speleodb'} className="flex-1 min-h-0"><SpeleoWorkspace /></div>
    </div>
  );
}
