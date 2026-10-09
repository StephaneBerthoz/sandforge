import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { OrgSafetyTier } from '@sandforge/shared';
import type { BaseMessage, CompareItem, CompareResult, SalesforceOrg } from '@sandforge/shared';
import i18n from '../../i18n';
import fr from '../../i18n/locales/fr.json';

/*
 * The panel with the bridge hooks it ships with, where DeployPanel.test.tsx
 * replaces them: what the user reads of a refusal is decided by the hook that
 * receives `compare:error`, so it is read through it here.
 */

const mockPostMessage = vi.fn();

/** Stable identity so useSendMessage's useCallback does not re-fire. */
const stableApi = {
  postMessage: (...args: unknown[]) => mockPostMessage(...args),
  getState: () => undefined,
  setState: () => undefined,
};

vi.mock('../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => stableApi,
  getVscodeApi: () => stableApi,
}));

vi.mock('../../hooks/useOperationProgress', () => ({
  useOperationProgress: () => ({ getProgress: () => undefined }),
}));

import { DeployPanel } from './DeployPanel';
import { enrichDiffs } from './enrichDiffs';

const org = (id: string, alias: string): SalesforceOrg => ({
  id,
  alias,
  username: `${alias.toLowerCase()}@example.com`,
  instanceUrl: `https://${alias.toLowerCase()}.example.com`,
  orgId: `00D${id}`,
  orgType: 'Sandbox',
  authMethod: 'oauth_web',
  safetyTier: OrgSafetyTier.LOW,
  appearance: { color: '#0070d2', icon: 'cloud', position: 0 },
  metadata: { apiVersion: '66.0', edition: 'Developer Edition', features: [] },
  status: 'connected',
  lastConnected: '2026-09-01T00:00:00Z',
  tags: [],
});

const DIFFS: CompareItem[] = [
  {
    componentType: 'ApexClass',
    fullName: 'Invoicing',
    status: 'modified',
    severity: 'warning',
    deployable: true,
  },
];

const RESULT: CompareResult = {
  configId: 'cfg-1',
  sourceOrgId: 'org-1',
  targetOrgId: 'org-2',
  mode: 'metadata',
  summary: {
    totalItems: 1,
    added: 0,
    removed: 0,
    modified: 1,
    unchanged: 0,
    notCompared: 0,
    byType: {},
  },
  content: {
    compared: 1,
    notCompared: { unreadable: 0, read_failed: 0, over_budget: 0 },
    budget: { components: 500, seconds: 90 },
  },
  diffs: DIFFS,
  timestamp: '2026-09-01T10:00:00Z',
  duration: 1000,
};

/** The last message of `type` the panel sent through the bridge. */
function sent(type: string): BaseMessage | undefined {
  return mockPostMessage.mock.calls
    .map((call) => (call[0] as { payload: BaseMessage }).payload)
    .filter((message) => message.type === type)
    .pop();
}

/** Answer the panel's validation on `compare:error`, correlated to it as the handler does. */
function refuseValidation(payload: Record<string, unknown>): void {
  const request = sent('compare:validate-deployment');
  if (!request) throw new Error("no 'compare:validate-deployment' was sent");
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          id: 'resp-refused',
          type: 'compare:error',
          timestamp: Date.now(),
          correlationId: request.id,
          payload,
        },
      }),
    );
  });
}

describe('DeployPanel — a validation Production Guard refused', () => {
  beforeEach(async () => {
    mockPostMessage.mockClear();
    i18n.addResourceBundle('fr', 'translation', fr, true, true);
    await act(async () => {
      await i18n.changeLanguage('fr');
    });
  });

  afterEach(async () => {
    await act(async () => {
      await i18n.changeLanguage('en');
    });
  });

  function validate(): void {
    render(
      <DeployPanel
        result={RESULT}
        report={enrichDiffs(RESULT.diffs)}
        orgs={[org('org-1', 'Uat'), org('org-2', 'Dev')]}
      />,
    );
    fireEvent.click(screen.getByTestId('deploy-pick-ApexClass:Invoicing'));
    fireEvent.click(screen.getByTestId('deploy-validate-btn'));
  }

  it('says the refusal in the panel’s language, the guard’s reason after it, not the English sentence', () => {
    validate();

    refuseValidation({
      message: 'Operation blocked by Production Guard: deploy is not allowed on production',
      code: 'GUARD_BLOCKED',
      retryable: false,
    });

    const banner = screen.getByTestId('deploy-validation-error').textContent ?? '';
    expect(banner).toContain(
      "Production Guard a refusé cette opération, et rien n'a été modifié dans l'org.",
    );
    expect(banner).toContain('deploy is not allowed on production');
    expect(banner).not.toContain('Operation blocked by Production Guard');
  });

  it('says a deployment cancelled at the guard’s confirmation in the panel’s language', () => {
    validate();

    refuseValidation({
      message: 'Operation cancelled by user (deployment confirmation declined).',
      code: 'GUARD_DECLINED',
      retryable: true,
    });

    expect(screen.getByTestId('deploy-validation-error').textContent).toContain(
      "Annulé à la confirmation de Production Guard : rien n'a été modifié dans l'org.",
    );
  });
});
