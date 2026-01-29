import { useUIStore, type ToolType } from '../../store/uiStore';
import { Button, IconButton } from '../common/Button';
import DisplayMenu from './DisplayMenu';
import UndoHistoryDropdown from './UndoHistoryDropdown';

interface ToolbarProps {
  projectName: string;
  onBack: () => void;
  onSave: () => void;
  onImport: () => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

export default function Toolbar({
  projectName,
  onBack,
  onSave,
  onImport,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
}: ToolbarProps) {
  const { activeTool, setActiveTool, openDialog } = useUIStore();

  const tools: { id: ToolType; label: string; shortcut: string }[] = [
    { id: 'select', label: 'Select', shortcut: 'S' },
    { id: 'pan', label: 'Pan', shortcut: 'P' },
    { id: 'zoom', label: 'Zoom', shortcut: 'Z' },
    { id: 'draw', label: 'Draw', shortcut: 'D' },
    { id: 'delete', label: 'Delete', shortcut: 'X' },
    { id: 'merge', label: 'Merge', shortcut: 'M' },
    { id: 'measure', label: 'Measure', shortcut: 'R' },
  ];

  return (
    <header className="flex items-center justify-between px-4 py-2 border-b border-border bg-panel" data-testid="toolbar">
      {/* Left section */}
      <div className="flex items-center gap-2">
        <Button onClick={onBack} size="sm" data-testid="back-button">
          ← Back
        </Button>
        <Button onClick={onSave} size="sm" data-testid="toolbar-save-button">
          Save
        </Button>
        <Button onClick={() => onImport()} size="sm" data-testid="toolbar-import-button">
          Import
        </Button>
        <Button onClick={() => openDialog('export')} size="sm" data-testid="toolbar-export-button">
          Export
        </Button>
        <div className="w-px h-6 bg-border mx-2" />
        <UndoHistoryDropdown
          mode="undo"
          disabled={!canUndo}
          onSingleAction={onUndo}
          testId="toolbar-undo-button"
        >
          <span className="inline-flex items-center gap-0.5">
            Undo
            {canUndo && <span className="text-[10px] opacity-60" aria-hidden="true" data-testid="undo-chevron">{' '}▾</span>}
          </span>
        </UndoHistoryDropdown>
        <UndoHistoryDropdown
          mode="redo"
          disabled={!canRedo}
          onSingleAction={onRedo}
          testId="toolbar-redo-button"
        >
          <span className="inline-flex items-center gap-0.5">
            Redo
            {canRedo && <span className="text-[10px] opacity-60" aria-hidden="true" data-testid="redo-chevron">{' '}▾</span>}
          </span>
        </UndoHistoryDropdown>
      </div>

      {/* Center - project name */}
      <h1 className="font-medium" data-testid="toolbar-project-name">{projectName}</h1>

      {/* Right section - tools and display menu */}
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1 bg-background rounded px-1 py-1">
          {tools.map((tool) => (
            <IconButton
              key={tool.id}
              icon={<ToolIcon tool={tool.id} />}
              active={activeTool === tool.id}
              onClick={() => setActiveTool(tool.id)}
              tooltip={`${tool.label} (${tool.shortcut})`}
              size="sm"
              aria-pressed={activeTool === tool.id}
              data-testid={`tool-${tool.id}`}
            />
          ))}
        </div>
        <DisplayMenu />
      </div>
    </header>
  );
}

function ToolIcon({ tool }: { tool: ToolType }) {
  // Simple text icons for now - can be replaced with SVG icons
  const icons: Record<ToolType, string> = {
    select: '↖',
    pan: '✋',
    zoom: '🔍',
    draw: '✏',
    delete: '✕',
    merge: '⊕',
    measure: '📏',
    move_section: '↔',
    move_station: '⤢',
    move_segment: '⇔',
    move_shot: '⇄',
  };

  return <span className="text-sm">{icons[tool]}</span>;
}
