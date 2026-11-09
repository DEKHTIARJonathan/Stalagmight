import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '../../store/uiStore';
import { SpeleoWorkspace } from './SpeleoWorkspace';
import { SectionsTabIcon, SpeleoTabIcon, useSpeleoTabState } from './workspaceTabIcons';
import type { ReactNode } from 'react';

export function LeftWorkspace({ sections }: { sections: ReactNode }) {
  const { t } = useTranslation();
  const tab = useUIStore((s) => s.leftWorkspace);
  const mode = useUIStore((s) => s.appMode);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const tabs = mode === 'survey' ? ['sections', 'speleodb'] as const : ['speleodb'] as const;
  const choose = useUIStore((s) => s.selectLeftWorkspace);
  const speleoState = useSpeleoTabState();
  // The tab's own words for its badge, as its accessible description (and tooltip).
  const speleoNote = speleoState === 'unuploaded' ? t('speleodb.workspaceTab.unuploaded')
    : speleoState === 'read-only' ? t('speleodb.workspaceTab.readOnly') : null;
  return (
    <div className="h-full min-h-0 flex flex-col">
      <div role="tablist" aria-label="Project workspace" className="flex shrink-0 border-b border-border">
        {tabs.map((id, index) => {
          const selected = tab === id;
          const warn = id === 'speleodb' && speleoState === 'unuploaded';
          const note = id === 'speleodb' ? speleoNote : null;
          // Un-uploaded work tints the tab in the warning tokens (text, wash and a
          // bottom rule), selected or not; otherwise the usual selected/idle look.
          const look = warn
            ? `text-warning shadow-[inset_0_-2px_0_var(--cc-warning)] ${selected ? 'bg-warning-20 font-medium' : 'bg-warning-10'}`
            : selected ? 'bg-accent-10 font-medium' : 'text-text-secondary';
          return <button key={id} ref={(el) => { refs.current[index] = el; }}
            id={`workspace-tab-${id}`} role="tab" type="button" aria-selected={selected}
            aria-controls={`workspace-panel-${id}`} tabIndex={selected ? 0 : -1}
            aria-describedby={note ? 'workspace-tab-speleodb-note' : undefined}
            title={note ?? undefined}
            data-testid={`workspace-tab-${id}`} data-state={id === 'speleodb' ? speleoState : undefined}
            onClick={() => choose(id)}
            onKeyDown={(event) => {
              const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
              if (next === null) return;
              event.preventDefault(); const nextTab = tabs[next]; if (nextTab) choose(nextTab); refs.current[next]?.focus();
            }}
            className={`flex-1 min-w-0 flex items-center justify-center gap-1.5 px-3 py-2 text-sm whitespace-nowrap focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${look}`}>
            {id === 'speleodb' ? <SpeleoTabIcon state={speleoState} /> : <SectionsTabIcon />}
            <span>{id === 'speleodb' ? 'SpeleoDB' : 'Sections'}</span>
          </button>;
        })}
      </div>
      {speleoNote && <span id="workspace-tab-speleodb-note" className="sr-only" data-testid="workspace-tab-speleodb-note">{speleoNote}</span>}
      <div role="tabpanel" id="workspace-panel-sections" aria-labelledby="workspace-tab-sections" hidden={mode !== 'survey' || tab !== 'sections'} className="flex-1 min-h-0">{sections}</div>
      <div role="tabpanel" id="workspace-panel-speleodb" aria-labelledby="workspace-tab-speleodb" hidden={tab !== 'speleodb'} className="flex-1 min-h-0"><SpeleoWorkspace /></div>
    </div>
  );
}
