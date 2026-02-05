import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './i18n';
import './index.css';
import { useUIStore } from './store/uiStore';
import { useProjectStore, type LoadingState } from './store/projectStore';
import { useGlobalViewStore } from './store/globalViewStore';

// Expose stores for E2E testing
declare global {
  interface Window {
    __E2E_TEST__?: {
      uiStore?: typeof useUIStore;
      projectStore?: typeof useProjectStore;
      globalViewStore?: typeof useGlobalViewStore;
      // Loading progress E2E hooks
      getLoadingId?: () => number;
      getBackendLoadingId?: () => bigint;
      simulateLoadingProgress?: (payload: Partial<LoadingState>) => void;
      simulateLoadingError?: (message: string, details?: string) => void;
      resetLoading?: () => void;
    };
  }
}

// Expose stores for E2E testing (dev/test mode or explicit E2E build flag)
// Guarded to prevent shipping internal store access to production builds
// Uses additive pattern to avoid clobbering other test helpers
if (import.meta.env.DEV || import.meta.env.MODE === 'test' || import.meta.env.VITE_E2E === '1') {
  const testAPI = window.__E2E_TEST__ || {};
  testAPI.uiStore = useUIStore;
  testAPI.projectStore = useProjectStore;
  testAPI.globalViewStore = useGlobalViewStore;
  window.__E2E_TEST__ = testAPI;
}

// Expose loading hooks for E2E tests (dev/test mode or explicit E2E build flag)
// IMPORTANT: Extend existing hooks, don't overwrite
if (import.meta.env.DEV || import.meta.env.MODE === 'test' || import.meta.env.VITE_E2E === '1') {
  const existingHooks = window.__E2E_TEST__ || {};
  window.__E2E_TEST__ = {
    ...existingHooks, // PRESERVE existing uiStore, projectStore, etc.
    // Use clientOpId for reliable tracking - loadingId may be 0 until first event
    getLoadingId: () => useProjectStore.getState().loading.clientOpId,
    getBackendLoadingId: () => useProjectStore.getState().loading.loadingId,
    simulateLoadingProgress: (payload: Partial<LoadingState>) => {
      useProjectStore.getState().setLoadingProgress(payload);
    },
    simulateLoadingError: (message: string, details?: string) => {
      useProjectStore.getState().setLoadingError(message, details);
    },
    resetLoading: () => useProjectStore.getState().resetLoading(),
  };
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element not found');
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
