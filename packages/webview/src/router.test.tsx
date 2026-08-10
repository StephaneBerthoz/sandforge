import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import './i18n';
import { useAppStore } from './stores/useAppStore';
import { useOrgStore } from './stores/useOrgStore';
import { Router } from './router';

/* Mock framer-motion for components that use m/motion */
const MOTION_KEYS = new Set([
  'variants',
  'initial',
  'animate',
  'whileHover',
  'whileTap',
  'transition',
  'exit',
]);

vi.mock('framer-motion', async () => {
  const React = await import('react');
  const makeMotion = <E extends keyof HTMLElementTagNameMap>(tag: E) =>
    React.forwardRef<HTMLElementTagNameMap[E], Record<string, unknown>>((props, ref) => {
      const filtered: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        if (!MOTION_KEYS.has(k)) filtered[k] = v;
      }
      return React.createElement(tag, { ...filtered, ref });
    });
  const mockDiv = makeMotion('div');
  return {
    m: { div: mockDiv },
    motion: {
      div: mockDiv,
      button: makeMotion('button'),
      tbody: makeMotion('tbody'),
      tr: makeMotion('tr'),
    },
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
    LazyMotion: ({ children }: { children: React.ReactNode }) => children,
  };
});

/* Mock bridge hooks used by HomePage */
vi.mock('./hooks/useBridgeQuery', () => ({
  useBridgeQuery: () => ({
    data: null,
    loading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

vi.mock('./hooks/useBridgeMutation', () => ({
  useBridgeMutation: () => ({
    mutate: vi.fn(),
    data: null,
    loading: false,
    error: null,
    reset: vi.fn(),
  }),
}));

describe('Router', () => {
  beforeEach(() => {
    useAppStore.setState({ currentRoute: 'home' });
    useOrgStore.setState({ orgs: [], selectedOrgId: null });
  });

  it('should render the home page by default', () => {
    render(<Router />);
    expect(screen.getByTestId('home-page')).toBeDefined();
  });

  it('should render the reports page', () => {
    useAppStore.setState({ currentRoute: 'reports' });
    render(<Router />);
    expect(screen.getByTestId('reports-page')).toBeDefined();
  });

  it('should render the settings page', () => {
    useAppStore.setState({ currentRoute: 'settings' });
    render(<Router />);
    expect(screen.getByTestId('settings-page')).toBeDefined();
  });

  it('should switch routes when store changes', () => {
    const { rerender } = render(<Router />);
    expect(screen.getByTestId('home-page')).toBeDefined();
    useAppStore.setState({ currentRoute: 'monitor' });
    rerender(<Router />);
    /* MonitorPage renders EmptyState when no orgs exist */
    expect(screen.getByTestId('empty-state')).toBeDefined();
  });
});
