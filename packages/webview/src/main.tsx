import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { PanelApp } from './PanelApp';
import { SidePanel } from './SidePanel';
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
        <SidePanel />
      ) : moduleId ? (
        <PanelApp moduleId={moduleId} />
      ) : (
        <App />
      )}
    </React.StrictMode>,
  );
}
