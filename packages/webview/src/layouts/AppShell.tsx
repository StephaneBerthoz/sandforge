import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { cn } from '../theme';
import { Sidebar } from './Sidebar/Sidebar';
import { TopBar } from './TopBar/TopBar';
import { StatusFooter } from './StatusFooter/StatusFooter';
import { NotificationCenter } from './NotificationCenter/NotificationCenter';
import { FloatingToasts } from '../components/ui/FloatingToasts';
import { SkipLink } from '../components/ui/SkipLink';
import { KeyboardShortcuts } from '../components/ui/KeyboardShortcuts';
import { Router } from '../router';
import { useAppStore } from '../stores/useAppStore';
import { useGlobalShortcuts } from '../hooks/useGlobalShortcuts';

/** AppShell component props. */
export interface AppShellProps {
  className?: string;
}

/** Main application shell with sidebar, topbar, content area, status footer, and notification center. */
export const AppShell: React.FC<AppShellProps> = ({ className }) => {
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const currentRoute = useAppStore((s) => s.currentRoute);
  const mainRef = useRef<HTMLElement>(null);
  useGlobalShortcuts();

  /**
   * Scroll restoration: `<main>` never unmounts, so it would otherwise keep
   * its scrollTop across navigation and open the next page scrolled down.
   * Reset to top on every route change (standard SPA behaviour).
   */
  useEffect(() => {
    if (mainRef.current) {
      mainRef.current.scrollTop = 0;
    }
  }, [currentRoute]);

  return (
    <div
      className={cn(
        'flex h-screen w-full overflow-hidden relative',
        'bg-surface-0 text-text-primary',
        className,
      )}
      data-testid="app-shell"
    >
      <SkipLink />
      <Sidebar />
      <div className="flex flex-col flex-1 min-w-0">
        <TopBar onNotificationsToggle={() => setNotificationsOpen((prev) => !prev)} />
        <main ref={mainRef} id="main-content" className="flex-1 overflow-auto p-4" tabIndex={-1}>
          {/*
            Why the keyed wrapper stays: removing `key={currentRoute}` would NOT
            preserve page state — Router renders a different component type per
            route, so React unmounts/remounts the page subtree either way. The
            key is load-bearing for exit animations instead: pages using
            `exit="hidden"` motion variants (e.g. HomePage) only animate out
            because the keyed subtree unmounts inside AnimatePresence
            mode="wait". A keep-alive alternative (mount visited pages once,
            hide inactive) was rejected: simultaneously mounted pages risk
            duplicate data-testid attributes (Playwright strict-mode
            violations) and keep background bridge subscriptions and timers
            alive. Page state that matters already survives the remount via
            zustand stores / persisted drafts (useForgeStore, useSeedWizardStore,
            useFrozenStore, useWebviewPersistedState sync/quickSync drafts);
            the remaining remount refetches (Monitor panels, Sync object list)
            are cheap queries where fresh data is desirable.
          */}
          <AnimatePresence mode="wait">
            <div key={currentRoute}>
              <Router />
            </div>
          </AnimatePresence>
        </main>
        <StatusFooter />
      </div>
      <NotificationCenter open={notificationsOpen} onClose={() => setNotificationsOpen(false)} />
      <FloatingToasts />
      <KeyboardShortcuts />
    </div>
  );
};
