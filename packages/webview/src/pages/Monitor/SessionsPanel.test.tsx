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
          userId: 'user-1',
          username: 'admin@dev.sandbox',
          sessionType: 'UI',
          loginTime: '2026-03-20T10:00:00Z',
          sourceIp: '192.168.1.1',
        },
        {
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
    expect(screen.getByTestId('session-row-user-1')).toBeDefined();
    expect(screen.getByTestId('session-row-user-2')).toBeDefined();
    expect(screen.getByText('2 active user(s)')).toBeDefined();
  });

  it('displays session type as badge', () => {
    mockData = {
      success: true,
      sessions: [
        {
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
});
