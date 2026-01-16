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

// Always expose stores for E2E testing
// This is safe because the stores are already accessible through React DevTools
window.__E2E_TEST__ = {
  uiStore: useUIStore,
  projectStore: useProjectStore,
};

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element not found');
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
