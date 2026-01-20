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
      uiStore: typeof useUIStore;
      projectStore: typeof useProjectStore;
    };
  }
}

// Expose stores for E2E testing (only in dev/test mode)
// Guarded to prevent shipping internal store access to production builds
// Using process.env.NODE_ENV which Vite replaces at build time
if (process.env.NODE_ENV !== 'production') {
  window.__E2E_TEST__ = {
    uiStore: useUIStore,
    projectStore: useProjectStore,
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
