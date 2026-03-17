import React, { useState } from 'react';
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
  useGlobalShortcuts();

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
        <TopBar />
        <main id="main-content" className="flex-1 overflow-auto p-4" tabIndex={-1}>
          <AnimatePresence mode="wait">
            <div key={currentRoute}>
              <Router />
            </div>
          </AnimatePresence>
        </main>
        <StatusFooter />
      </div>
      <NotificationCenter
        open={notificationsOpen}
        onClose={() => setNotificationsOpen(false)}
      />
      <FloatingToasts />
      <KeyboardShortcuts />
    </div>
  );
};
