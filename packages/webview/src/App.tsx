import React, { useState, useCallback, useEffect, useRef } from 'react';
import './i18n';
import { BridgeProvider } from './bridge/BridgeProvider';
import { MotionProvider } from './motion/MotionProvider';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { AppShell } from './layouts/AppShell';
import { MojitoOverlay } from './components/EasterEgg/MojitoOverlay';
import { CommandPalette } from './components/CommandPalette/CommandPalette';
import { WelcomePage } from './pages/Welcome/WelcomePage';
import { WhatsNewPage } from './pages/Welcome/WhatsNewPage';
import { useKonamiCode } from './hooks/useKonamiCode';
import { useAppStore } from './stores/useAppStore';
import { useSendMessage } from './hooks/useMessageBus';
import { buildMessage } from './bridge/messageHelpers';
import { getHarnessFlow } from './pages/E2EHarness/harnessFlow';

/**
 * E2E harness, loaded on demand and ONLY in e2e builds.
 *
 * The ternary is compile-time constant: `vite.config.ts` (prod) defines
 * `import.meta.env.VITE_E2E` as `''`, so Rollup tree-shakes the dead branch —
 * `E2EHarness` (and its `DriftFeed` dependency) never reach the production
 * IIFE bundle. `vite.config.e2e.ts` defines it as `'1'`, so the Playwright
 * dev server lazy-loads the harness on `?e2e-harness=<flow>` URLs.
 */
const LazyE2EHarness = import.meta.env.VITE_E2E
  ? React.lazy(async () => {
      const mod = await import('./pages/E2EHarness/E2EHarness');
      return { default: mod.E2EHarness };
    })
  : null;

/** Inner component that uses hooks (must be inside providers). */
const AppInner: React.FC = () => {
  const [showEasterEgg, setShowEasterEgg] = useState(false);
  const logoClickCount = useRef(0);
  const logoClickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showWelcome = useAppStore((s) => s.showWelcome);
  const showWhatsNew = useAppStore((s) => s.showWhatsNew);
  const whatsNewVersion = useAppStore((s) => s.whatsNewVersion);
  const setShowWelcome = useAppStore((s) => s.setShowWelcome);
  const setShowWhatsNew = useAppStore((s) => s.setShowWhatsNew);
  const sendMessage = useSendMessage();

  /** Trigger 1: Konami Code. */
  useKonamiCode(useCallback(() => setShowEasterEgg(true), []));

  /** Trigger 2: Extension message. */
  useEffect(() => {
    const handler = (event: MessageEvent): void => {
      // SECURITY: Validate origin — only accept messages from the VSCode webview host.
      if (event.origin && !event.origin.startsWith('vscode-webview://')) {
        return;
      }
      if (event.data?.type === 'easter-egg:show') {
        setShowEasterEgg(true);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  /** Trigger 3: 7 clicks on SandForge title/logo. */
  useEffect(() => {
    const handler = (event: MouseEvent): void => {
      const target = event.target as HTMLElement;
      if (
        target.textContent?.includes('SandForge') &&
        (target.tagName === 'H1' ||
          target.tagName === 'SPAN' ||
          target.closest('[data-testid="app-logo"]'))
      ) {
        logoClickCount.current += 1;
        if (logoClickTimer.current) {
          clearTimeout(logoClickTimer.current);
        }
        logoClickTimer.current = setTimeout(() => {
          logoClickCount.current = 0;
        }, 3000);
        if (logoClickCount.current >= 7) {
          setShowEasterEgg(true);
          logoClickCount.current = 0;
        }
      }
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, []);

  /** Handle welcome wizard completion. */
  const handleWelcomeComplete = useCallback((): void => {
    setShowWelcome(false);
    sendMessage(buildMessage('onboarding:complete', { skipped: false }));
  }, [setShowWelcome, sendMessage]);

  /** Handle what's new dismissal. */
  const handleWhatsNewDismiss = useCallback((): void => {
    setShowWhatsNew(false);
  }, [setShowWhatsNew]);

  return (
    <>
      <AppShell />
      <CommandPalette />
      {showWelcome && (
        <div
          className="fixed inset-0 z-[100] bg-black/50 flex items-center justify-center"
          role="dialog"
          aria-modal="true"
          aria-label="Welcome wizard"
        >
          <div className="w-full max-h-screen overflow-auto">
            <WelcomePage onComplete={handleWelcomeComplete} />
          </div>
        </div>
      )}
      {showWhatsNew && (
        <div
          className="fixed inset-0 z-[100] bg-black/50 flex items-center justify-center"
          role="dialog"
          aria-modal="true"
          aria-label="What's new"
        >
          <div className="w-full max-h-screen overflow-auto">
            <WhatsNewPage version={whatsNewVersion} onDismiss={handleWhatsNewDismiss} />
          </div>
        </div>
      )}
      {showEasterEgg && <MojitoOverlay onClose={() => setShowEasterEgg(false)} />}
    </>
  );
};

/** Root application component for the SandForge WebView. */
export const App: React.FC = () => {
  // E2E harness short-circuit: when `?e2e-harness=<flow>` is present in the URL,
  // render a lightweight placeholder surface instead of the full app. Keeps
  // Plan 02-03 Playwright specs deterministic and decoupled from features that
  // are delivered in Phase 04 (AI) and Phase 05 (CDC). The harness component
  // only exists in e2e builds (see LazyE2EHarness above).
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

  return (
    <ErrorBoundary>
      <BridgeProvider>
        <MotionProvider>
          <AppInner />
        </MotionProvider>
      </BridgeProvider>
    </ErrorBoundary>
  );
};
