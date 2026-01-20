import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { useUIStore } from './store/uiStore';
import { useProjectStore } from './store/projectStore';

// Expose stores for E2E testing
declare global {
  interface Window {
    __E2E_TEST__?: {
      uiStore?: typeof useUIStore;
      projectStore?: typeof useProjectStore;
    };
  }
}

// Expose stores for E2E testing (only in dev/test mode)
// Guarded to prevent shipping internal store access to production builds
// Uses additive pattern to avoid clobbering other test helpers
if (import.meta.env.DEV || import.meta.env.MODE === 'test') {
  const testAPI = window.__E2E_TEST__ || {};
  testAPI.uiStore = useUIStore;
  testAPI.projectStore = useProjectStore;
  window.__E2E_TEST__ = testAPI;
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
