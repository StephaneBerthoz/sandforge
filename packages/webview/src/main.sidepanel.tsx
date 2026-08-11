import React from 'react';
import ReactDOM from 'react-dom/client';
import { SidePanel } from './SidePanel';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { MotionProvider } from './motion/MotionProvider';
import { i18nReady } from './i18n';
import './index.css';
import './styles/glass.css';

/**
 * Sidebar-only entry — built to `assets/sidepanel.js` via
 * `vite build --mode sidepanel` (see vite.config.ts).
 *
 * Deliberately imports ONLY the SidePanel branch of main.tsx's runtime switch:
 * no PanelApp/PanelRouter and no pages/* module, so tree-shaking drops the
 * entire panel surface (recharts, reactflow, E2EHarness, …) from this bundle.
 * Keep it that way — anything the sidebar needs must come through SidePanel.
 */
const root = document.getElementById('root');
if (root) {
  // Anti-flash gate: same as main.tsx — hold the first render until the
  // persisted language's bundle has crossed the bridge (or the gate timeout
  // fell back to English), so a restored non-English UI never paints English
  // first.
  void i18nReady.then(() => {
    ReactDOM.createRoot(root).render(
      <React.StrictMode>
        {/* SidePanel has no BridgeProvider ancestor of its own — give it the
            same crash-recovery boundary the other roots get from PanelApp, and
            the same motion context (LazyMotion features + reducedMotion="user"). */}
        <ErrorBoundary>
          <MotionProvider>
            <SidePanel />
          </MotionProvider>
        </ErrorBoundary>
      </React.StrictMode>,
    );
  });
}
