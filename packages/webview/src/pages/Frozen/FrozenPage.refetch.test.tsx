import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import type {
  BaseMessage,
  FrozenLoadReportInfo,
  FrozenStatusInfo,
  SalesforceOrg,
} from '@sandforge/shared';
import '../../i18n';

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

import { FrozenPage } from './FrozenPage';
import { useOrgStore } from '../../stores/useOrgStore';
import { useFrozenStore } from '../../stores/useFrozenStore';

/**
 * The page against the real bridge hooks: every request it sends is counted,
 * and answered as the extension answers it.
 */

const DEV = {
  id: 'org-dev',
  alias: 'DEV-SANDBOX',
  status: 'connected',
} as unknown as SalesforceOrg;

const STATUS: FrozenStatusInfo = {
  configured: true,
  sasDir: '/sas',
  datasetDir: '/sas/dataset',
  salt: { present: false },
  mockDetectionConfigured: false,
  selection: null,
  manifest: {
    version: '1.0.0',
    status: 'frozen',
    frozenAt: '2026-09-24T09:00:00.000Z',
    source: { orgId: 'org-uat', decisionDate: '2026-09-24T09:00:00.000Z' },
    saltFingerprint: 'abc123def456',
    rulesVersion: '1',
    volumetry: { budgetMax: 2500, measured: {}, measuredAt: '2026-09-24T09:00:00.000Z' },
    controls: {
      nonReidentification: { passed: true, checks: [], author: 'a', checkedAt: '2026-09-24' },
      dryRunLoad: null,
      author: 'a',
      date: '2026-09-24',
    },
  },
  lastLoad: null,
  lastVerify: null,
  lastLoadRecords: {
    orgId: 'org-dev',
    loadedAt: '2026-09-24T10:05:00.000Z',
    created: [{ objectApiName: 'Account', count: 1 }],
    linked: 0,
    recorded: true,
  },
};

const REPORT: FrozenLoadReportInfo = {
  status: 'completed',
  orgId: 'org-dev',
  mode: { pilot: false, reload: false },
  startedAt: '2026-09-24T10:00:00.000Z',
  durationMs: 1,
  alignment: { excludedObjects: [], removals: [], adjustments: [], recordTypeIssues: [] },
  placeholders: [],
  requiredDefaults: [],
  perObject: [],
  pass2: { resolved: 0, unresolved: [] },
  personContact: { restored: 0, unresolved: [] },
  purge: { deleted: {}, deactivated: {}, failures: [] },
  mappingPath: '/sas/referenceid-mapping.json',
  contractPath: '/sas/contract.json',
};

/** Every message of `type` the page sent. */
function sentAll(type: string): Array<BaseMessage & { payload?: Record<string, unknown> }> {
  return mockPostMessage.mock.calls
    .map(
      (call) =>
        (call[0] as { payload: BaseMessage & { payload?: Record<string, unknown> } }).payload,
    )
    .filter((message) => message.type === type);
}

/** Answer one request, correlated to it as the handler does. */
function answer(request: BaseMessage, type: string, payload: unknown): void {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          id: `resp-${request.id}-${type}`,
          type,
          timestamp: Date.now(),
          correlationId: request.id,
          payload,
        },
      }),
    );
  });
}

/**
 * Answer every status request sent from `from` on, as they come, for a few
 * rounds: how many there were.
 */
function answerStatuses(from: number): number {
  let answered = 0;
  for (let round = 0; round < 10; round++) {
    const pending = sentAll('frozen:status').slice(from + answered);
    if (pending.length === 0) break;
    for (const request of pending) {
      answer(request, 'frozen:status:response', { status: { ...STATUS } });
      answered++;
    }
  }
  return answered;
}

describe('FrozenPage — the status it reads again', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
    useOrgStore.setState({ orgs: [DEV], selectedOrgId: DEV.id });
    useFrozenStore.setState({
      tab: 'load',
      status: null,
      loadReport: null,
      progress: [],
      lastError: null,
    });
    render(<FrozenPage />);
    answerStatuses(0);
  });

  it('reads the status once after a load answers, however many answers the status gets', () => {
    fireEvent.click(screen.getByTestId('frozen-load-run'));
    const load = sentAll('frozen:load').pop();
    if (!load) throw new Error("no 'frozen:load' was sent");
    const before = sentAll('frozen:status').length;

    answer(load, 'frozen:load:response', { report: REPORT });

    expect(answerStatuses(before)).toBe(1);
  });

  it('reads the status once after a load ends on an error, whose mapping names what it wrote', () => {
    // Read only after a load that answered, the card went on offering the
    // load before it, and its removal was refused as another load's.
    fireEvent.click(screen.getByTestId('frozen-load-run'));
    const load = sentAll('frozen:load').pop();
    if (!load) throw new Error("no 'frozen:load' was sent");
    const before = sentAll('frozen:status').length;

    answer(load, 'frozen:load:error', {
      message:
        'Production guard refused insert on Contact: not on this org\n' +
        'The load failed after it had created 1 record(s) (Account: 1).',
      code: 'GUARD_REFUSED',
      retryable: false,
    });

    expect(answerStatuses(before)).toBe(1);
  });

  it('reads the status again when a removal is refused for a load recorded since, and offers that one', () => {
    // The card went on offering the load it showed, and was refused for it
    // again: the status is the page's, read when it opens, and the refusal's
    // "open the Load tab again" read nothing.
    fireEvent.click(screen.getByTestId('frozen-removal-remove'));
    fireEvent.change(screen.getByTestId('danger-input'), { target: { value: DEV.alias } });
    fireEvent.click(screen.getByTestId('danger-confirm-btn'));
    const removal = sentAll('frozen:remove').pop();
    if (!removal) throw new Error("no 'frozen:remove' was sent");
    const before = sentAll('frozen:status').length;

    answer(removal, 'frozen:remove:error', {
      message:
        'Another load was recorded since this one was shown, and nothing was removed: check ' +
        'what a removal takes now, then confirm it again.',
      code: 'LOAD_CHANGED',
      retryable: false,
    });

    const reads = sentAll('frozen:status').slice(before);
    expect(reads).toHaveLength(1);
    // The load recorded since, as the status now names it.
    answer(reads[0], 'frozen:status:response', {
      status: {
        ...STATUS,
        lastLoadRecords: {
          orgId: 'org-dev',
          loadedAt: '2026-09-24T11:05:00.000Z',
          created: [{ objectApiName: 'Contact', count: 3 }],
          linked: 0,
          recorded: true,
        },
      },
    });
    expect(answerStatuses(before + 1)).toBe(0);
    fireEvent.click(screen.getByTestId('frozen-removal-remove'));
    expect(
      within(screen.getByTestId('forge-removal-plan'))
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Contact: 3 records']);
    // Confirmed, it names the load the status names now.
    fireEvent.change(screen.getByTestId('danger-input'), { target: { value: DEV.alias } });
    fireEvent.click(screen.getByTestId('danger-confirm-btn'));
    expect(sentAll('frozen:remove').pop()?.payload).toEqual({
      targetOrgId: 'org-dev',
      loadedAt: '2026-09-24T11:05:00.000Z',
    });
  });

  it('reads the status once after a removal answers', () => {
    fireEvent.click(screen.getByTestId('frozen-removal-remove'));
    fireEvent.change(screen.getByTestId('danger-input'), { target: { value: DEV.alias } });
    fireEvent.click(screen.getByTestId('danger-confirm-btn'));
    const removal = sentAll('frozen:remove').pop();
    if (!removal) throw new Error("no 'frozen:remove' was sent");
    const before = sentAll('frozen:status').length;

    answer(removal, 'frozen:remove:response', {
      operationId: 'frozen-remove-1',
      result: {
        status: 'success',
        includeChanged: false,
        objects: [],
        finishedAt: '2026-09-24T11:00:00.000Z',
      },
    });

    expect(answerStatuses(before)).toBe(1);
  });
});
