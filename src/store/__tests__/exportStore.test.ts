import { describe, it, expect, beforeEach } from 'vitest';
import { useExportStore, DEFAULT_IMAGE_OPTIONS } from '../exportStore';

describe('exportStore', () => {
  beforeEach(() => {
    useExportStore.setState({
      exportType: 'image',
      dataFormat: 'csv',
      imageOptions: DEFAULT_IMAGE_OPTIONS,
    });
  });

  it('defaults to the image type so Export mode shows the preview immediately', () => {
    expect(useExportStore.getState().exportType).toBe('image');
  });

  it('default image options are monochrome PNG with labels on (colors opt-in)', () => {
    expect(DEFAULT_IMAGE_OPTIONS).toEqual({
      format: 'png',
      dpi: 300,
      branching_threshold: 2,
      show_penetration_labels: true,
      show_colors: false,
    });
  });

  it('updates each slice independently', () => {
    const s = useExportStore.getState();
    s.setExportType('data');
    s.setDataFormat('tml');
    s.setImageOptions({ ...DEFAULT_IMAGE_OPTIONS, show_colors: true });
    const next = useExportStore.getState();
    expect(next.exportType).toBe('data');
    expect(next.dataFormat).toBe('tml');
    expect(next.imageOptions.show_colors).toBe(true);
  });
});
