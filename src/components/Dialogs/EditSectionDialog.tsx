import { useState, useEffect } from 'react';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { Button } from '../common/Button';

export default function EditSectionDialog() {
  const { closeDialog, dialogData } = useUIStore();
  const { updateSection, project } = useProjectStore();

  const sectionId = dialogData.sectionId as number | undefined;
  const section = project?.sections.find((s) => s.id === sectionId);

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [name, setName] = useState('');
  const [surveyor, setSurveyor] = useState('');
  const [date, setDate] = useState('');
  const [color, setColor] = useState('#4ecdc4');

  // Initialize form with section data
  useEffect(() => {
    if (section) {
      setName(section.name ?? '');
      setSurveyor(section.surveyor ?? '');
      setDate(section.date ?? '');
      setColor(section.color);
    }
  }, [section]);

  const handleSave = async () => {
    if (!sectionId) return;

    setIsLoading(true);
    setError(null);

    try {
      const result = await updateSection(sectionId, {
        name: name.trim() || null,
        surveyor: surveyor.trim() || null,
        date: date.trim() || null,
        color,
      });

      if (result.success) {
        closeDialog();
      } else {
        setError(result.error ?? 'Failed to update section');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update section');
    } finally {
      setIsLoading(false);
    }
  };

  if (!section) {
    return (
      <DialogWrapper title="Edit Section" onClose={closeDialog}>
        <div className="text-error">Section not found</div>
      </DialogWrapper>
    );
  }

  return (
    <DialogWrapper title="Edit Section" onClose={closeDialog}>
      <div className="space-y-4">
        {error && (
          <div className="p-3 bg-error/10 border border-error/20 rounded text-error text-sm">
            {error}
          </div>
        )}

        <div>
          <label className="block text-sm text-text-secondary mb-1">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full"
            placeholder="Section name"
          />
        </div>

        <div>
          <label className="block text-sm text-text-secondary mb-1">Surveyor</label>
          <input
            type="text"
            value={surveyor}
            onChange={(e) => setSurveyor(e.target.value)}
            className="w-full"
            placeholder="Surveyor name"
          />
        </div>

        <div>
          <label className="block text-sm text-text-secondary mb-1">Date</label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-full"
          />
        </div>

        <div>
          <label className="block text-sm text-text-secondary mb-1">Color</label>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="w-10 h-10 rounded cursor-pointer"
            />
            <input
              type="text"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="flex-1"
              placeholder="#4ecdc4"
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-4 border-t border-border">
          <Button onClick={closeDialog} disabled={isLoading}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleSave} disabled={isLoading}>
            {isLoading ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}

interface DialogWrapperProps {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}

function DialogWrapper({ title, onClose, children }: DialogWrapperProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-panel border border-border rounded-lg shadow-xl max-w-md w-full mx-4">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-lg font-medium">{title}</h2>
          <button
            onClick={onClose}
            className="text-text-secondary hover:text-text-primary text-xl"
          >
            ×
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}
