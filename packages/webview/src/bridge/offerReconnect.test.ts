import { describe, it, expect, beforeEach } from 'vitest';
import { act } from '@testing-library/react';
import '../i18n';
import { offerReconnect } from './offerReconnect';
import { useNotificationStore } from '../stores/useNotificationStore';
import { useAppStore } from '../stores/useAppStore';
import { useOrgStore } from '../stores/useOrgStore';

describe('offerReconnect', () => {
  beforeEach(() => {
    useNotificationStore.setState({ notifications: [] });
    useAppStore.setState({ currentRoute: 'sync', navigationIntent: null });
    useOrgStore.setState({ orgs: [], selectedOrgId: null });
  });

  it('names the org whose session expired, and reconnects it from Organizations', () => {
    useOrgStore.setState({
      orgs: [{ id: 'org-1', alias: 'uat', username: 'admin@example.com' }] as never,
    });

    offerReconnect({ code: 'ORG_AUTH_EXPIRED', orgId: 'org-1' });

    const [toast] = useNotificationStore.getState().notifications;
    expect(toast.level).toBe('warning');
    expect(toast.message).toBe('The session with uat has expired. Reconnect it to go on.');
    expect(toast.actions?.[0].label).toBe('Reconnect');
    act(() => toast.actions?.[0].onAction?.());
    expect(useAppStore.getState().navigationIntent).toEqual({
      route: 'orgs',
      reconnectOrgId: 'org-1',
    });
  });

  it('offers nothing when the error names no org', () => {
    offerReconnect({ code: 'ORG_AUTH_EXPIRED' });
    offerReconnect(undefined);

    expect(useNotificationStore.getState().notifications).toHaveLength(0);
  });
});
