import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { PanelApp } from './PanelApp';
import { SidePanel } from './SidePanel';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import './index.css';
import './styles/glass.css';

declare global {
  interface Window {
    __SANDFORGE_MODULE__?: string;
  }
}

const root = document.getElementById('root');
if (root) {
  const moduleId = window.__SANDFORGE_MODULE__;
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      {moduleId === 'sidepanel' ? (
        // SidePanel has no BridgeProvider/App ancestor — give it the same
        // crash-recovery boundary the other roots get from App.tsx.
        <ErrorBoundary>
          <SidePanel />
        </ErrorBoundary>
      ) : moduleId ? (
        <PanelApp moduleId={moduleId} />
      ) : (
        <App />
      )}
    </React.StrictMode>,
  );
}
