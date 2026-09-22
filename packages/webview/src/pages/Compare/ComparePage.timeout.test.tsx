import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import '../../i18n';
import { OrgSafetyTier } from '@sandforge/shared';
import type { BaseMessage, SalesforceOrg } from '@sandforge/shared';
import { useOrgStore } from '../../stores/useOrgStore';
import { ComparePage } from './ComparePage';

/*
 * The page with its real bridge hooks: only the VS Code API is a stand-in, so
 * the request's own timeout is the one that runs.
 */
const mockPostMessage = vi.fn();
const api = { postMessage: mockPostMessage, getState: () => undefined, setState: () => undefined };

vi.mock('../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => api,
  getVscodeApi: () => api,
}));

function org(id: string, alias: string): SalesforceOrg {
  return {
    id,
    alias,
    username: `${alias.toLowerCase()}@example.com`,
    instanceUrl: `https://${alias.toLowerCase()}.example.com`,
    orgId: id,
    orgType: 'Sandbox',
    authMethod: 'sfdx_import',
    safetyTier: OrgSafetyTier.LOW,
    appearance: { color: '#4a9eff', icon: 'cloud', position: 0 },
    metadata: { apiVersion: '62.0', edition: 'Enterprise Edition', features: [] },
    status: 'connected',
    lastConnected: '2026-01-01T00:00:00Z',
    tags: [],
  };
}

describe('ComparePage — a comparison that takes its time', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockPostMessage.mockClear();
    useOrgStore.setState({
      orgs: [org('org-src', 'SRC'), org('org-tgt', 'TGT')],
      selectedOrgId: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('still shows the diff when the extension answers after thirty seconds', () => {
    // Every category listed against two real sandboxes took from 24 s to
    // 106 s, most of it the one listMetadata call for 24,000 custom fields.
    // The page gave up at 30 s, showed its timeout, and dropped the diff that
    // followed.
    render(<ComparePage />);
    fireEvent.change(screen.getByLabelText('Source Org'), { target: { value: 'org-src' } });
    fireEvent.change(screen.getByLabelText('Target Org'), { target: { value: 'org-tgt' } });
    fireEvent.click(screen.getByTestId('cat-CustomField'));
    fireEvent.click(screen.getByTestId('run-compare-btn'));

    const sent = mockPostMessage.mock.calls
      .map(([envelope]) => (envelope as { payload: BaseMessage }).payload)
      .find((message) => message.type === 'compare:execute');
    expect(sent).toBeDefined();

    act(() => {
      vi.advanceTimersByTime(45_000);
    });
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            id: 'reply-1',
            type: 'compare:execute:response',
            timestamp: Date.now(),
            correlationId: sent?.id,
            payload: {
              configId: 'cfg-1',
              sourceOrgId: 'org-src',
              targetOrgId: 'org-tgt',
              mode: 'metadata',
              summary: {
                totalItems: 3,
                added: 1,
                removed: 1,
                modified: 0,
                unchanged: 1,
                byType: {},
              },
              diffs: [],
              timestamp: '2026-01-01T00:00:45Z',
              duration: 45_000,
            },
          },
        }),
      );
    });

    expect(screen.queryByTestId('compare-error')).toBeNull();
    expect(screen.getByTestId('compare-summary').textContent).toContain('+1');
  });
});
