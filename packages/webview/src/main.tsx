import React from 'react';
import ReactDOM from 'react-dom/client';
import { PanelApp } from './PanelApp';
import { SidePanel } from './SidePanel';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { MotionProvider } from './motion/MotionProvider';
import { getHarnessFlow } from './pages/E2EHarness/harnessFlow';
import { i18nReady } from './i18n';
import './index.css';
import './styles/glass.css';

declare global {
  interface Window {
    __SANDFORGE_MODULE__?: string;
  }
}

/**
 * E2E harness, loaded on demand and ONLY in e2e builds.
 *
 * The ternary is compile-time constant: `vite.config.ts` (prod) defines
 * `import.meta.env.VITE_E2E` as `''`, so Rollup tree-shakes the dead branch —
 * `E2EHarness` never reaches the production IIFE bundle. `vite.config.e2e.ts`
 * defines it as `'1'`, so the Playwright dev server lazy-loads the harness on
 * `?e2e-harness=<flow>` URLs (those specs inject no `__SANDFORGE_MODULE__`).
 */
const LazyE2EHarness = import.meta.env.VITE_E2E
  ? React.lazy(async () => {
      const mod = await import('./pages/E2EHarness/E2EHarness');
      return { default: mod.E2EHarness };
    })
  : null;

/**
 * Fallback when the host injected no module id — a plain dev-server session
 * or the Playwright e2e harness. The harness takes precedence when the URL
 * asks for it; otherwise the Home page renders through the exact PanelApp
 * provider stack (ErrorBoundary + BridgeProvider + MotionProvider), keeping a
 * functional dev playground without the deleted App/AppShell shell.
 */
const NoModuleFallback: React.FC = () => {
  const harnessFlow =
    LazyE2EHarness && typeof window !== 'undefined' ? getHarnessFlow(window.location.search) : null;
  if (harnessFlow && LazyE2EHarness) {
    return (
      <ErrorBoundary>
        <React.Suspense fallback={null}>
          <LazyE2EHarness flow={harnessFlow} />
        </React.Suspense>
      </ErrorBoundary>
    );
  }
  return <PanelApp moduleId="home" />;
};

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
