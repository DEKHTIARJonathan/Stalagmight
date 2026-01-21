import { useUIStore, type ToolType } from '../../store/uiStore';
import { Button, IconButton } from '../common/Button';
import DisplayMenu from './DisplayMenu';

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
    <header className="flex items-center justify-between px-4 py-2 border-b border-border bg-panel">
      {/* Left section */}
      <div className="flex items-center gap-2">
        <Button onClick={onBack} size="sm" data-testid="back-button">
          ← Back
        </Button>
        <Button onClick={onSave} size="sm">
          Save
        </Button>
        <Button onClick={() => onImport()} size="sm">
          Import
        </Button>
        <Button onClick={() => openDialog('export')} size="sm">
          Export
        </Button>
        <div className="w-px h-6 bg-border mx-2" />
        <Button onClick={onUndo} size="sm" disabled={!canUndo}>
          Undo
        </Button>
        <Button onClick={onRedo} size="sm" disabled={!canRedo}>
          Redo
        </Button>
      </div>

      {/* Center - project name */}
      <h1 className="font-medium">{projectName}</h1>

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
  };

  return <span className="text-sm">{icons[tool]}</span>;
}
