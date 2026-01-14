import { useProjectStore } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';

interface SystemCardProps {
  name: string;
  location: string | null;
  filePath: string;
  modifiedAt: string;
  sectionCount: number;
  totalLength: number;
}

export default function SystemCard({
  name,
  location,
  filePath,
  modifiedAt,
  sectionCount,
  totalLength,
}: SystemCardProps) {
  const { openProject } = useProjectStore();
  const { setView } = useUIStore();

  const handleClick = async () => {
    const result = await openProject(filePath);
    if (result.success) {
      setView('single');
    }
  };

  const handleDoubleClick = async () => {
    await handleClick();
  };

  const formatDate = (dateStr: string) => {
    try {
      const date = new Date(dateStr);
      return date.toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
    } catch {
      return dateStr;
    }
  };

  const formatLength = (meters: number) => {
    if (meters >= 1000) {
      return `${(meters / 1000).toFixed(1)} km`;
    }
    return `${meters.toFixed(0)} m`;
  };

  return (
    <div
      className="
        bg-panel border border-border rounded-lg p-4
        cursor-pointer hover:border-accent transition-colors
      "
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
    >
      <h3 className="text-lg font-medium mb-1">{name}</h3>
      {location && (
        <p className="text-sm text-text-secondary mb-3">{location}</p>
      )}

      <div className="grid grid-cols-2 gap-2 text-sm">
        <div>
          <span className="text-text-secondary">Sections:</span>{' '}
          <span>{sectionCount}</span>
        </div>
        <div>
          <span className="text-text-secondary">Length:</span>{' '}
          <span>{formatLength(totalLength)}</span>
        </div>
      </div>

      <div className="mt-3 pt-3 border-t border-border text-xs text-text-secondary">
        Modified: {formatDate(modifiedAt)}
      </div>
    </div>
  );
}
