import React from 'react';
import ReactDOM from 'react-dom/client';
import { PanelApp } from './PanelApp';
import { SidePanel } from './SidePanel';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { MotionProvider } from './motion/MotionProvider';
import { i18nReady } from './i18n';
import './index.css';
import './styles/glass.css';

declare global {
  interface Window {
    __SANDFORGE_MODULE__?: string;
  }
}

/**
 * Fallback when the host injected no module id (a plain dev-server session, for
 * one): the Home page renders through the exact PanelApp provider stack
 * (ErrorBoundary + BridgeProvider + MotionProvider), keeping a functional dev
 * playground without the deleted App/AppShell shell.
 */
const NoModuleFallback: React.FC = () => <PanelApp moduleId="home" />;

const root = document.getElementById('root');
if (root) {
  const moduleId = window.__SANDFORGE_MODULE__;
  // Anti-flash gate: hold the first render until the persisted language's
  // bundle has crossed the bridge (or the gate timeout fell back to English),
  // so a restored non-English UI never paints English first.
  void i18nReady.then(() => {
    ReactDOM.createRoot(root).render(
      <React.StrictMode>
        {moduleId === 'sidepanel' ? (
          // SidePanel has no BridgeProvider ancestor of its own — give it the
          // same crash-recovery boundary the other roots get from PanelApp, and
          // the same motion context (LazyMotion features + reducedMotion="user").
          <ErrorBoundary>
            <MotionProvider>
              <SidePanel />
            </MotionProvider>
          </ErrorBoundary>
        ) : moduleId ? (
          <PanelApp moduleId={moduleId} />
        ) : (
          <NoModuleFallback />
        )}
      </React.StrictMode>,
    );
  });
}
