import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import en from '../../../i18n/locales/en.json';

/**
 * MapLibre 6 throws `GPUInitializationError` from the `Map` constructor when no
 * WebGL2 context exists (#606). The map host must show the WebGL2 message in
 * place of the map instead of letting the throw escape its effect.
 */

const h = vi.hoisted(() => {
  class GPUInitializationError extends Error {
    readonly statusMessage: string | null = null;
  }
  const state = { error: new GPUInitializationError('no webgl2') as Error };
  class FakeMap {
    constructor() {
      throw state.error;
    }
  }
  return { GPUInitializationError, FakeMap, state };
});

vi.mock('maplibre-gl', () => ({
  Map: h.FakeMap,
  GPUInitializationError: h.GPUInitializationError,
}));

import '../../../i18n';
import SectionPreview from '../../Dialogs/SectionPreview';
import { createMap } from '../createMap';

describe('map without WebGL2', () => {
  beforeEach(() => {
    h.state.error = new h.GPUInitializationError('no webgl2');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('shows the WebGL2 message in place of the map', () => {
    render(<SectionPreview />);
    const status = screen.getByTestId('section-preview-webgl2-unavailable');
    expect(status).toHaveTextContent(en.map.webgl2Unavailable.title);
    expect(status).toHaveTextContent(en.map.webgl2Unavailable.body);
    expect(screen.getByTestId('section-preview')).toBeInTheDocument();
  });

  it('createMap returns null only for the WebGL2 error and rethrows anything else', () => {
    const container = document.createElement('div');
    expect(createMap({ container })).toBeNull();
    h.state.error = new Error('boom');
    expect(() => createMap({ container })).toThrow('boom');
  });
});
