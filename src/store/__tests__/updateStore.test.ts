import { describe, it, expect, beforeEach } from 'vitest';
import { useUpdateStore } from '../updateStore';

beforeEach(() => {
  useUpdateStore.getState().reset();
});

describe('updateStore transitions', () => {
  it('starts idle with no info', () => {
    const s = useUpdateStore.getState();
    expect(s.status).toBe('idle');
    expect(s.info).toBeNull();
    expect(s.dismissedVersion).toBeNull();
  });

  it('startChecking -> checking', () => {
    useUpdateStore.getState().startChecking();
    expect(useUpdateStore.getState().status).toBe('checking');
  });

  it('setUpToDate clears info and progress', () => {
    useUpdateStore.getState().setAvailable({ version: '1.2.3', notesUrl: 'https://x' });
    useUpdateStore.getState().setProgress({ downloaded: 10, total: 100 });
    useUpdateStore.getState().setUpToDate();
    const s = useUpdateStore.getState();
    expect(s.status).toBe('idle');
    expect(s.info).toBeNull();
    expect(s.progress).toBeNull();
  });

  it('setCheckFailed goes idle without touching info', () => {
    useUpdateStore.getState().setAvailable({ version: '1.2.3', notesUrl: 'https://x' });
    useUpdateStore.getState().setCheckFailed();
    const s = useUpdateStore.getState();
    expect(s.status).toBe('idle');
    expect(s.info).toEqual({ version: '1.2.3', notesUrl: 'https://x' });
  });

  it('setAvailable -> available with info', () => {
    useUpdateStore.getState().setAvailable({ version: '1.2.3', notesUrl: 'https://x' });
    const s = useUpdateStore.getState();
    expect(s.status).toBe('available');
    expect(s.info).toEqual({ version: '1.2.3', notesUrl: 'https://x' });
  });

  it('startDownloading -> downloading, setProgress updates progress', () => {
    useUpdateStore.getState().setAvailable({ version: '1.2.3', notesUrl: 'https://x' });
    useUpdateStore.getState().startDownloading();
    expect(useUpdateStore.getState().status).toBe('downloading');
    useUpdateStore.getState().setProgress({ downloaded: 50, total: 100 });
    expect(useUpdateStore.getState().progress).toEqual({ downloaded: 50, total: 100 });
  });

  it('setReady -> ready', () => {
    useUpdateStore.getState().setAvailable({ version: '1.2.3', notesUrl: 'https://x' });
    useUpdateStore.getState().startDownloading();
    useUpdateStore.getState().setReady();
    expect(useUpdateStore.getState().status).toBe('ready');
  });

  it('setDownloadFailed with existing info falls back to available', () => {
    useUpdateStore.getState().setAvailable({ version: '1.2.3', notesUrl: 'https://x' });
    useUpdateStore.getState().startDownloading();
    useUpdateStore.getState().setDownloadFailed();
    const s = useUpdateStore.getState();
    expect(s.status).toBe('available');
    expect(s.progress).toBeNull();
    expect(s.info).toEqual({ version: '1.2.3', notesUrl: 'https://x' });
  });

  it('setDownloadFailed with no info falls back to error', () => {
    useUpdateStore.getState().setDownloadFailed();
    expect(useUpdateStore.getState().status).toBe('error');
  });

  it('dismiss records the dismissed version, session only', () => {
    useUpdateStore.getState().dismiss('1.2.3');
    expect(useUpdateStore.getState().dismissedVersion).toBe('1.2.3');
  });
});
