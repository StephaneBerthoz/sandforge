import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useAppStore } from './stores/useAppStore';
import { useOrgStore } from './stores/useOrgStore';
import { App } from './App';

/* Mock framer-motion to avoid LazyMotion strict mode issues */
const MOTION_KEYS = new Set(['variants', 'initial', 'animate', 'whileHover', 'whileTap', 'transition', 'exit']);

vi.mock('framer-motion', async () => {
  const React = await import('react');
  const makeMotion = <E extends keyof HTMLElementTagNameMap>(tag: E) =>
    React.forwardRef<HTMLElementTagNameMap[E], Record<string, unknown>>(
      (props, ref) => {
        const filtered: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(props)) {
          if (!MOTION_KEYS.has(k)) filtered[k] = v;
        }
        return React.createElement(tag, { ...filtered, ref });
      },
    );
  const mockDiv = makeMotion('div');
  return {
    m: { div: mockDiv },
    motion: { div: mockDiv, button: makeMotion('button'), tbody: makeMotion('tbody'), tr: makeMotion('tr') },
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
    LazyMotion: ({ children }: { children: React.ReactNode }) => children,
    domAnimation: {},
  };
});

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

describe('App', () => {
  beforeEach(() => {
    localStorageMock.reset();
    useAppStore.setState({ currentRoute: 'home', sidebarCollapsed: false });
    useOrgStore.setState({ orgs: [] });
  });

  it('should render the app shell with SandForge branding', () => {
    render(<App />);
    expect(screen.getByText('SandForge')).toBeDefined();
  });

  it('should render the sidebar navigation', () => {
    render(<App />);
    expect(screen.getByTestId('sidebar')).toBeDefined();
  });
});
