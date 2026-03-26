import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../i18n';
import { useAppStore } from '../stores/useAppStore';
import { useOrgStore } from '../stores/useOrgStore';
import { useRecentOpsStore } from '../stores/useRecentOpsStore';
import { AppShell } from './AppShell';

/* Mock localStorage for components that use it */
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string): string | null => store[key] ?? null,
    setItem: (key: string, value: string): void => { store[key] = value; },
    removeItem: (key: string): void => { delete store[key]; },
    reset: (): void => { store = {}; },
  };
})();
Object.defineProperty(window, 'localStorage', { value: localStorageMock, writable: true });

describe('AppShell', () => {
  beforeEach(() => {
    localStorageMock.reset();
    useAppStore.setState({ currentRoute: 'home', sidebarCollapsed: false });
    useOrgStore.setState({ orgs: [] });
    useRecentOpsStore.setState({ ops: [] });
  });

  it('should render the app shell', () => {
    render(<AppShell />);
    expect(screen.getByTestId('app-shell')).toBeDefined();
  });

  it('should render the sidebar', () => {
    render(<AppShell />);
    expect(screen.getByTestId('sidebar')).toBeDefined();
  });

  it('should render the topbar', () => {
    render(<AppShell />);
    expect(screen.getByTestId('topbar')).toBeDefined();
  });

  it('should render the status footer', () => {
    render(<AppShell />);
    expect(screen.getByTestId('status-footer')).toBeDefined();
  });

  it('should render the home page content by default', () => {
    render(<AppShell />);
    expect(screen.getByText('SandForge')).toBeDefined();
  });

  it('should wrap router content with AnimatePresence key', () => {
    render(<AppShell />);
    // AnimatePresence wraps a div keyed by currentRoute
    const shell = screen.getByTestId('app-shell');
    expect(shell.querySelector('main')).toBeDefined();
  });

  it('should render a skip link for keyboard navigation', () => {
    render(<AppShell />);
    const skipLink = screen.getByText('Skip to main content');
    expect(skipLink).toBeDefined();
    expect(skipLink.tagName).toBe('A');
    expect(skipLink.getAttribute('href')).toBe('#main-content');
  });

  it('should have id="main-content" on the main content area', () => {
    render(<AppShell />);
    const main = document.getElementById('main-content');
    expect(main).toBeDefined();
    expect(main?.tagName).toBe('MAIN');
  });

  it('should have tabIndex=-1 on the main content for programmatic focus', () => {
    render(<AppShell />);
    const main = document.getElementById('main-content');
    expect(main?.tabIndex).toBe(-1);
  });
});
