import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { useOrgStore } from '../../stores/useOrgStore';
import { SessionsPanel } from './SessionsPanel';

let mockData: Record<string, unknown> | null = null;
let mockLoading = false;

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: (type: string) => {
    if (type === 'monitor:sessions') {
      return { data: mockData, loading: mockLoading, error: null, refetch: vi.fn() };
    }
    return { data: null, loading: false, error: null, refetch: vi.fn() };
  },
}));

describe('SessionsPanel', () => {
  beforeEach(() => {
    mockData = null;
    mockLoading = false;
    useOrgStore.setState({ selectedOrgId: 'org-1', orgs: [] });
  });

  it('renders loading skeleton when loading', () => {
    mockLoading = true;
    render(<SessionsPanel />);
    expect(screen.getByTestId('sessions-panel-loading')).toBeDefined();
  });

  it('renders empty state when no sessions', () => {
    mockData = { success: true, sessions: [], activeUserCount: 0 };
    render(<SessionsPanel />);
    expect(screen.getByTestId('sessions-panel-empty')).toBeDefined();
    expect(screen.getByText('Active Sessions')).toBeDefined();
  });

  it('renders session rows with user count badge', () => {
    mockData = {
      success: true,
      sessions: [
        {
          sessionId: 'session-1',
          userId: 'user-1',
          username: 'admin@dev.sandbox',
          sessionType: 'UI',
          loginTime: '2026-03-20T10:00:00Z',
          sourceIp: '192.168.1.1',
        },
        {
          sessionId: 'session-2',
          userId: 'user-2',
          username: 'api@dev.sandbox',
          sessionType: 'API',
          loginTime: '2026-03-20T10:05:00Z',
          sourceIp: '10.0.0.1',
        },
      ],
      activeUserCount: 2,
    };
    render(<SessionsPanel />);

    expect(screen.getByTestId('sessions-panel')).toBeDefined();
    expect(screen.getByTestId('session-row-session-1')).toBeDefined();
    expect(screen.getByTestId('session-row-session-2')).toBeDefined();
    expect(screen.getByText('2 active user(s)')).toBeDefined();
  });

  it('displays session type as badge', () => {
    mockData = {
      success: true,
      sessions: [
        {
          sessionId: 'session-1',
          userId: 'user-1',
          username: 'admin@dev.sandbox',
          sessionType: 'UI',
          loginTime: '2026-03-20T10:00:00Z',
          sourceIp: '192.168.1.1',
        },
      ],
      activeUserCount: 1,
    };
    render(<SessionsPanel />);

    expect(screen.getByText('UI')).toBeDefined();
  });

  it('gives each session of the same user its own row', () => {
    // Two sessions of one user shared a React key while the rows were keyed by
    // user id: the second row was dropped from the list it belongs to.
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockData = {
      success: true,
      sessions: [
        {
          sessionId: 'session-1',
          userId: 'user-1',
          username: 'admin@dev.sandbox',
          sessionType: 'UI',
          loginTime: '2026-03-20T10:00:00Z',
          sourceIp: '192.168.1.1',
        },
        {
          sessionId: 'session-2',
          userId: 'user-1',
          username: 'admin@dev.sandbox',
          sessionType: 'API',
          loginTime: '2026-03-20T10:05:00Z',
          sourceIp: '10.0.0.1',
        },
      ],
      activeUserCount: 1,
    };

    render(<SessionsPanel />);

    expect(screen.getByTestId('session-row-session-1')).toBeDefined();
    expect(screen.getByTestId('session-row-session-2')).toBeDefined();
    expect(screen.getAllByText('admin@dev.sandbox')).toHaveLength(2);
    expect(warn.mock.calls.filter((call) => String(call[0]).includes('same key'))).toHaveLength(0);
    warn.mockRestore();
  });

  /** Two sessions, as the most recent of an org that holds more. */
  const SESSIONS = [
    {
      sessionId: 'session-1',
      userId: 'user-1',
      username: 'admin@dev.sandbox',
      sessionType: 'UI',
      loginTime: '2026-03-20T10:00:00Z',
      sourceIp: '192.168.1.1',
    },
    {
      sessionId: 'session-2',
      userId: 'user-2',
      username: 'api@dev.sandbox',
      sessionType: 'API',
      loginTime: '2026-03-20T10:05:00Z',
      sourceIp: '10.0.0.1',
    },
  ];

  it('says the list and its user count stop where the read did', () => {
    // The read stopped at 100 sessions without a word, and the active-user
    // badge counted the users of those 100 as the org's.
    mockData = { success: true, sessions: SESSIONS, activeUserCount: 2, truncated: true };
    render(<SessionsPanel />);

    expect(screen.getByTestId('sessions-list-cap').textContent).toBe(
      'Only the 2 most recent are read here: the list and its counts stop there.',
    );
  });

  it('says nothing of a bound when the list is complete', () => {
    mockData = { success: true, sessions: SESSIONS, activeUserCount: 2, truncated: false };
    render(<SessionsPanel />);

    expect(screen.queryByTestId('sessions-list-cap')).toBeNull();
  });
});
