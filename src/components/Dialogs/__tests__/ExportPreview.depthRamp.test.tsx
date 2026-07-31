import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';

import ExportPreview from '../ExportPreview';
import { useProjectStore } from '../../../store/projectStore';
import { DEFAULT_IMAGE_OPTIONS } from '../../../store/exportStore';
import type { ExportImageOptions } from '../../../types/commands';

const invokeIpcMock = vi.hoisted(() => vi.fn());

vi.mock('../../../utils/ipc', () => ({
  invokeIpc: invokeIpcMock,
}));

/**
 * #360, second half. Stamping the theme's depth endpoints onto `export_image`
 * alone would have made this component LIE: its contract is that the preview is
 * "pixel-for-pixel what the backend will write", and `preview_svg_export` is a
 * separate command invoked straight from here, bypassing the store.
 *
 * It is not saved by SVG being monochrome either - what suppresses colour is
 * `options.format == Svg`, and the preview is asked for the REAL format, so
 * previewing a PNG/PDF export in depth mode does emit the ramp. Without this
 * the light theme showed a dark-ramp preview beside a themed file.
 */
describe('ExportPreview depth endpoints (#360)', () => {
  const previewOptions = (): ExportImageOptions => {
    const call = invokeIpcMock.mock.calls.find((c) => c[0] === 'preview_svg_export');
    return (call![1] as { options: ExportImageOptions }).options;
  };

  beforeEach(() => {
    invokeIpcMock.mockReset();
    invokeIpcMock.mockResolvedValue('<svg></svg>');
    document.documentElement.style.setProperty('--cc-depth-shallow', '#14487f');
    document.documentElement.style.setProperty('--cc-depth-deep', '#a52a1a');
    // The preview only fires for an open project.
    useProjectStore.setState({ project: { name: 'T', sections: [] } as never });
  });

  it('asks the backend for the LIVE theme ramp, matching what export writes', async () => {
    vi.useFakeTimers();
    try {
      render(<ExportPreview options={{ ...DEFAULT_IMAGE_OPTIONS, color_mode: 'depth' }} />);
      // The request is debounced behind a timer.
      await vi.advanceTimersByTimeAsync(500);
    } finally {
      vi.useRealTimers();
    }

    await waitFor(() => {
      expect(invokeIpcMock.mock.calls.some((c) => c[0] === 'preview_svg_export')).toBe(true);
    });
    expect(previewOptions().depth_shallow).toBe('#14487f');
    expect(previewOptions().depth_deep).toBe('#a52a1a');
  });
});
