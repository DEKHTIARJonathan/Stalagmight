import { useState, useEffect } from 'react';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';

export default function EditShotDialog() {
  const { closeDialog, dialogData } = useUIStore();
  const { updateShot, project } = useProjectStore();

  const sectionId = dialogData.sectionId as number | undefined;
  const shotId = dialogData.shotId as number | undefined;

  const section = project?.sections.find((s) => s.id === sectionId);
  const shot = section?.shots.find((s) => s.id === shotId);

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [azimuthIn, setAzimuthIn] = useState('');
  const [azimuthOut, setAzimuthOut] = useState('');
  const [length, setLength] = useState('');
  const [depthIn, setDepthIn] = useState('');
  const [depthOut, setDepthOut] = useState('');
  const [pitchIn, setPitchIn] = useState('');
  const [pitchOut, setPitchOut] = useState('');
  const [left, setLeft] = useState('');
  const [right, setRight] = useState('');
  const [up, setUp] = useState('');
  const [down, setDown] = useState('');
  const [comment, setComment] = useState('');

  // Initialize form with shot data
  useEffect(() => {
    if (shot) {
      setAzimuthIn(shot.azimuth_in.toString());
      setAzimuthOut(shot.azimuth_out.toString());
      setLength(shot.length.toString());
      setDepthIn(shot.depth_in.toString());
      setDepthOut(shot.depth_out.toString());
      setPitchIn(shot.pitch_in?.toString() ?? '');
      setPitchOut(shot.pitch_out?.toString() ?? '');
      setLeft(shot.left?.toString() ?? '');
      setRight(shot.right?.toString() ?? '');
      setUp(shot.up?.toString() ?? '');
      setDown(shot.down?.toString() ?? '');
      setComment(shot.comment ?? '');
    }
  }, [shot]);

  // Normalize azimuth to 0-360 range
  const normalizeAzimuth = (value: number): number => {
    let normalized = value % 360;
    if (normalized < 0) normalized += 360;
    return normalized;
  };

  const validateForm = (): boolean => {
    const lengthVal = parseFloat(length);
    if (isNaN(lengthVal) || lengthVal <= 0) {
      setError('Length must be greater than 0');
      return false;
    }

    const azInVal = parseFloat(azimuthIn);
    if (isNaN(azInVal) || azInVal < -360 || azInVal > 360) {
      setError('Azimuth In must be between -360 and 360');
      return false;
    }

    const azOutVal = parseFloat(azimuthOut);
    if (isNaN(azOutVal) || azOutVal < -360 || azOutVal > 360) {
      setError('Azimuth Out must be between -360 and 360');
      return false;
    }

    return true;
  };

  const handleSave = async () => {
    if (sectionId === undefined || shotId === undefined) return;

    if (!validateForm()) return;

    setIsLoading(true);
    setError(null);

    try {
      const result = await updateShot(sectionId, shotId, {
        azimuth_in: normalizeAzimuth(parseFloat(azimuthIn)),
        azimuth_out: normalizeAzimuth(parseFloat(azimuthOut)),
        length: parseFloat(length),
        depth_in: parseFloat(depthIn),
        depth_out: parseFloat(depthOut),
        pitch_in: pitchIn ? parseFloat(pitchIn) : null,
        pitch_out: pitchOut ? parseFloat(pitchOut) : null,
        left: left ? parseFloat(left) : null,
        right: right ? parseFloat(right) : null,
        up: up ? parseFloat(up) : null,
        down: down ? parseFloat(down) : null,
        comment: comment.trim() || null,
        is_virtual: shot?.is_virtual ?? false,
        marker_index: shot?.marker_index ?? null,
        temperature: shot?.temperature ?? null,
      });

      if (result.success) {
        closeDialog();
      } else {
        setError(result.error ?? 'Failed to update shot');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update shot');
    } finally {
      setIsLoading(false);
    }
  };

  // Track if form has been modified
  const isDirty = shot ? (
    azimuthIn !== shot.azimuth_in.toString() ||
    azimuthOut !== shot.azimuth_out.toString() ||
    length !== shot.length.toString() ||
    depthIn !== shot.depth_in.toString() ||
    depthOut !== shot.depth_out.toString() ||
    pitchIn !== (shot.pitch_in?.toString() ?? '') ||
    pitchOut !== (shot.pitch_out?.toString() ?? '') ||
    left !== (shot.left?.toString() ?? '') ||
    right !== (shot.right?.toString() ?? '') ||
    up !== (shot.up?.toString() ?? '') ||
    down !== (shot.down?.toString() ?? '') ||
    comment !== (shot.comment ?? '')
  ) : false;

  if (!shot) {
    return (
      <DialogWrapper title="Edit Shot" onClose={closeDialog} size="lg" data-testid="edit-shot-dialog">
        <div className="text-error">Shot not found</div>
      </DialogWrapper>
    );
  }

  return (
    <DialogWrapper title="Edit Shot" onClose={closeDialog} size="lg" isDirty={isDirty} data-testid="edit-shot-dialog">
      <div className="space-y-4">
        {error && (
          <div className="p-3 bg-error-10 border border-error-20 rounded text-error text-sm">
            {error}
          </div>
        )}

        <div className="text-sm text-text-secondary">
          Section: {section?.name ?? `Section ${sectionId}`} | Shot ID: {shotId}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm text-text-secondary mb-1">Azimuth In (°)</label>
            <input
              type="number"
              value={azimuthIn}
              onChange={(e) => setAzimuthIn(e.target.value)}
              className="w-full"
              step="0.1"
            />
          </div>
          <div>
            <label className="block text-sm text-text-secondary mb-1">Azimuth Out (°)</label>
            <input
              type="number"
              value={azimuthOut}
              onChange={(e) => setAzimuthOut(e.target.value)}
              className="w-full"
              step="0.1"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm text-text-secondary mb-1">Length (m)</label>
          <input
            type="number"
            value={length}
            onChange={(e) => setLength(e.target.value)}
            className="w-full"
            step="0.01"
            min="0"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm text-text-secondary mb-1">Depth In (m)</label>
            <input
              type="number"
              value={depthIn}
              onChange={(e) => setDepthIn(e.target.value)}
              className="w-full"
              step="0.1"
            />
          </div>
          <div>
            <label className="block text-sm text-text-secondary mb-1">Depth Out (m)</label>
            <input
              type="number"
              value={depthOut}
              onChange={(e) => setDepthOut(e.target.value)}
              className="w-full"
              step="0.1"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm text-text-secondary mb-1">Pitch In (°)</label>
            <input
              type="number"
              value={pitchIn}
              onChange={(e) => setPitchIn(e.target.value)}
              className="w-full"
              step="0.1"
              placeholder="Optional"
            />
          </div>
          <div>
            <label className="block text-sm text-text-secondary mb-1">Pitch Out (°)</label>
            <input
              type="number"
              value={pitchOut}
              onChange={(e) => setPitchOut(e.target.value)}
              className="w-full"
              step="0.1"
              placeholder="Optional"
            />
          </div>
        </div>

        <div className="border-t border-border pt-3">
          <label className="block text-sm text-text-secondary mb-2">LRUD (m)</label>
          <div className="grid grid-cols-4 gap-2">
            <div>
              <input
                type="number"
                value={left}
                onChange={(e) => setLeft(e.target.value)}
                className="w-full"
                step="0.1"
                placeholder="L"
              />
            </div>
            <div>
              <input
                type="number"
                value={right}
                onChange={(e) => setRight(e.target.value)}
                className="w-full"
                step="0.1"
                placeholder="R"
              />
            </div>
            <div>
              <input
                type="number"
                value={up}
                onChange={(e) => setUp(e.target.value)}
                className="w-full"
                step="0.1"
                placeholder="U"
              />
            </div>
            <div>
              <input
                type="number"
                value={down}
                onChange={(e) => setDown(e.target.value)}
                className="w-full"
                step="0.1"
                placeholder="D"
              />
            </div>
          </div>
        </div>

        <div>
          <label className="block text-sm text-text-secondary mb-1">Comment</label>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            className="w-full h-20 resize-none"
            placeholder="Optional comment"
          />
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
