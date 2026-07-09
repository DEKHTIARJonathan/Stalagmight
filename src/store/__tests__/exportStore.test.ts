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
      color_mode: 'none',
      show_station_labels: false,
      show_section_names: false,
      show_station_comments: false,
      show_shot_comments: false,
      show_shot_data: false,
    });
  });

  it('updates each slice independently', () => {
    const s = useExportStore.getState();
    s.setExportType('data');
    s.setDataFormat('tml');
    s.setImageOptions({ ...DEFAULT_IMAGE_OPTIONS, color_mode: 'depth' });
    const next = useExportStore.getState();
    expect(next.exportType).toBe('data');
    expect(next.dataFormat).toBe('tml');
    expect(next.imageOptions.color_mode).toBe('depth');
  });
});
