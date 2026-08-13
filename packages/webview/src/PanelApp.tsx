import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import './i18n';
import { BridgeProvider } from './bridge/BridgeProvider';
import { MotionProvider } from './motion/MotionProvider';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { FloatingToasts } from './components/ui/FloatingToasts';
import { SkipLink } from './components/ui/SkipLink';
import { ProtocolMismatchBanner } from './components/ProtocolMismatchBanner';
import { CommandPalette } from './components/CommandPalette/CommandPalette';
import { WelcomePage } from './pages/Welcome/WelcomePage';
import { WhatsNewPage } from './pages/Welcome/WhatsNewPage';
import { MojitoOverlay } from './components/EasterEgg/MojitoOverlay';
import { PanelRouter } from './PanelRouter';
import { useGlobalShortcuts } from './hooks/useGlobalShortcuts';
import { useKonamiCode } from './hooks/useKonamiCode';
import { useSendMessage } from './hooks/useMessageBus';
import { buildMessage } from './bridge/messageHelpers';
import { useAppStore } from './stores/useAppStore';

/** Props for PanelApp. */
export interface PanelAppProps {
  moduleId: string;
}

/**
 * Inner panel content — calls hooks, so it must render under the providers.
 */
const PanelInner: React.FC<PanelAppProps> = ({ moduleId }) => {
  /**
   * The panel renders its own module until something navigates the shared
   * store (global shortcuts, command palette, welcome wizard). The store
   * defaults to 'home', so it cannot be trusted as the initial route source:
   * follow store *changes* from `moduleId` onwards instead of reading it
   * directly.
   */
  const { t } = useTranslation();

  const [route, setRoute] = useState(moduleId);
  useEffect(() => {
    setRoute(moduleId);
    return useAppStore.subscribe((state, prev) => {
      if (state.currentRoute !== prev.currentRoute) {
        setRoute(state.currentRoute);
      }
    });
  }, [moduleId]);

  /*
   * Global keyboard shortcuts (Ctrl+1..9/0, G+key chords, Ctrl+Enter,
   * Escape) — mounted here since the old App/AppShell shell is gone and
   * panels are the only production roots.
   * Known limitation: VS Code owns some of these chords at the workbench
   * level (Ctrl+1..8 focus editor groups, Ctrl+0 focuses the sidebar). When
   * the workbench consumes the keystroke the webview never receives it, so
   * the panel shortcut simply does not fire — the G+key chords remain the
   * reliable path. Behavior intentionally left as-is.
   */
  useGlobalShortcuts();

  const showWelcome = useAppStore((s) => s.showWelcome);
  const setShowWelcome = useAppStore((s) => s.setShowWelcome);
  const showWhatsNew = useAppStore((s) => s.showWhatsNew);
  const whatsNewVersion = useAppStore((s) => s.whatsNewVersion);
  const setShowWhatsNew = useAppStore((s) => s.setShowWhatsNew);
  const sendMessage = useSendMessage();

  /** Handle welcome wizard completion (same contract as App's overlay). */
  const handleWelcomeComplete = useCallback((): void => {
    setShowWelcome(false);
    sendMessage(buildMessage('onboarding:complete', { skipped: false }));
  }, [setShowWelcome, sendMessage]);

  /** Handle what's new dismissal (same contract as App's overlay). */
  const handleWhatsNewDismiss = useCallback((): void => {
    setShowWhatsNew(false);
  }, [setShowWhatsNew]);

  /*
   * Easter egg (mojito overlay) — same three triggers as the dead App shell
   * used to mount: Konami code, `easter-egg:show` from the `sandforge.cheers`
   * command, and 7 clicks on the SandForge title/logo. Without this wiring
   * the command posted into the void in production.
   */
  const [showEasterEgg, setShowEasterEgg] = useState(false);
  const logoClickCount = useRef(0);
  const logoClickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Trigger 1: Konami Code. */
  useKonamiCode(useCallback(() => setShowEasterEgg(true), []));

  /** Trigger 2: `sandforge.cheers` command message. */
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

  /** Trigger 3: 7 clicks on the SandForge title/logo. */
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

  return (
    <>
      <SkipLink />
      <ProtocolMismatchBanner />
      {/*
       * The panel body is the page's single `main` landmark: screen readers
       * jump straight here, and `tabIndex={-1}` makes it a valid target for
       * SkipLink's programmatic focus (a `main` is not focusable otherwise).
       */}
      <main
        id="main-content"
        tabIndex={-1}
        className="h-screen w-full overflow-auto bg-[var(--sf-bg-primary)] text-[var(--sf-text-primary)]"
        data-testid="panel-app"
      >
        <PanelRouter moduleId={route} />
      </main>
      <CommandPalette />
      {showWelcome && (
        <div
          className="fixed inset-0 z-[100] bg-black/50 flex items-center justify-center"
          role="dialog"
          aria-modal="true"
          aria-label={t('a11y.welcomeWizard', 'Welcome wizard')}
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
          aria-label={t('a11y.whatsNew', "What's new")}
        >
          <div className="w-full max-h-screen overflow-auto">
            <WhatsNewPage version={whatsNewVersion} onDismiss={handleWhatsNewDismiss} />
          </div>
        </div>
      )}
      {showEasterEgg && <MojitoOverlay onClose={() => setShowEasterEgg(false)} />}
      <FloatingToasts />
    </>
  );
};

/**
 * Root component for a full-width WebviewPanel.
 * Renders only the target module page — no sidebar, no topbar.
 * Each panel is an independent React instance with its own bridge.
 * Wrapped in the same ErrorBoundary as App so a render crash shows the
 * recovery UI instead of a blank panel, and in the same MotionProvider so
 * `m` components (e.g. HomePage) get their LazyMotion features and every
 * animation honors the OS prefers-reduced-motion setting.
 */
export const PanelApp: React.FC<PanelAppProps> = ({ moduleId }) => {
  return (
    <ErrorBoundary>
      <BridgeProvider>
        <MotionProvider>
          <PanelInner moduleId={moduleId} />
        </MotionProvider>
      </BridgeProvider>
    </ErrorBoundary>
  );
};
