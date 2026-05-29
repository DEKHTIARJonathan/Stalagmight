import { useEffect, useRef, useState } from 'react';
import { invokeIpc } from '../../utils/ipc';
import { useProjectStore } from '../../store/projectStore';
import type { ExportImageOptions } from '../../types/commands';

interface ExportPreviewProps {
  /** Export options that affect preview appearance. The SVG returned by
   *  `preview_svg_export` is pixel-for-pixel what the backend will write
   *  for these options, so preview and export cannot drift. */
  options: ExportImageOptions;
}

/** Debounce delay in milliseconds */
const DEBOUNCE_DELAY = 250;

/** Preview canvas dimensions (CSS pixels). */
const PREVIEW_SIZE = 300;

/**
 * Inline-SVG preview of the map export. Calls the backend's
 * `preview_svg_export` command (debounced) so the preview is the *exact*
 * markup the export will write — no separate rendering pipeline.
 */
export default function ExportPreview({ options }: ExportPreviewProps) {
  const project = useProjectStore((state) => state.project);

  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Track in-flight requests so a stale response can't overwrite a newer one.
  const requestSeqRef = useRef(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!project) {
      setSvg(null);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    const seq = ++requestSeqRef.current;
    timeoutRef.current = setTimeout(() => {
      // Always request SVG format for preview; user-selected format only
      // affects the saved file (PNG/PDF are SVG-derived anyway).
      const previewOptions: ExportImageOptions = { ...options, format: 'svg' };
      invokeIpc<string>('preview_svg_export', { options: previewOptions }, {
        purpose: 'render export preview',
      })
        .then((markup) => {
          if (seq !== requestSeqRef.current) return; // stale
          setSvg(markup);
          setError(null);
          setIsLoading(false);
        })
        .catch((err: unknown) => {
          if (seq !== requestSeqRef.current) return; // stale
          setSvg(null);
          setError(err instanceof Error ? err.message : String(err));
          setIsLoading(false);
        });
    }, DEBOUNCE_DELAY);

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [project, options]);

  return (
    <div
      data-testid="export-preview"
      className="relative border border-border rounded overflow-hidden bg-white flex items-center justify-center"
      style={{ width: PREVIEW_SIZE, height: PREVIEW_SIZE }}
    >
      {/* Inline SVG — the backend output is `<?xml ...?><svg .../>`. The
          wrapper div constrains the size; the SVG carries its own viewBox
          and scales to fit. */}
      {svg && (
        <div
          className="w-full h-full [&>svg]:w-full [&>svg]:h-full"
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}

      {/* Loading overlay */}
      {isLoading && (
        <div
          data-testid="export-preview-loading"
          className="absolute inset-0 flex items-center justify-center bg-white/80"
        >
          <div className="flex flex-col items-center gap-2">
            <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
            <span className="text-xs text-text-secondary">Rendering preview...</span>
          </div>
        </div>
      )}

      {/* Empty state when no project */}
      {!project && !isLoading && (
        <div className="absolute inset-0 flex items-center justify-center text-text-secondary text-sm">
          No project loaded
        </div>
      )}

      {/* Error state */}
      {error && !isLoading && (
        <div
          className="absolute inset-0 flex items-center justify-center p-3 text-text-secondary text-xs text-center"
          data-testid="export-preview-error"
        >
          Preview failed: {error}
        </div>
      )}
    </div>
  );
}
