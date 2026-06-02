import { type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ElidedPath } from '../common';

interface MissingSystemCardProps {
  name: string;
  filePath: string;
  onRemove: (filePath: string) => void;
}

/**
 * Card for a recent project whose file could not be loaded (moved, deleted, or
 * unreadable). It is de-emphasized, non-selectable, and offers a single action:
 * remove it from the recent list.
 */
export default function MissingSystemCard({ name, filePath, onRemove }: MissingSystemCardProps) {
  const { t } = useTranslation();

  const handleRemove = (e: MouseEvent) => {
    e.stopPropagation();
    onRemove(filePath);
  };

  return (
    <div
      className="bg-panel border border-border border-dashed rounded-lg p-4 opacity-70"
      data-testid={`system-card-missing-${filePath}`}
      data-missing="true"
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-lg font-medium mb-1 text-text-secondary line-through decoration-1">
          {name}
        </h3>
      </div>
      <ElidedPath path={filePath} className="text-xs text-text-tertiary mb-3" />

      <div className="mt-3 pt-3 border-t border-border flex items-center justify-between gap-2">
        <span className="text-xs text-warning">{t('globalView.recent.missing.notFound')}</span>
        <button
          type="button"
          onClick={handleRemove}
          className="text-xs text-text-secondary hover:text-danger underline"
          data-testid={`system-card-missing-remove-${filePath}`}
        >
          {t('globalView.recent.missing.remove')}
        </button>
      </div>
    </div>
  );
}
