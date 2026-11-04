import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import '../../i18n';
import type { FrozenLoadReportInfo, FrozenStatusInfo } from '@sandforge/shared';
import { useOrgStore } from '../../stores/useOrgStore';
import { useAppStore } from '../../stores/useAppStore';
import { useFrozenStore } from '../../stores/useFrozenStore';
import { developerOrg, productionOrg } from '../Checkpoint/testing/checkpointFixtures';

/*
 * "Take a checkpoint now" at the end of a load's report, against the real
 * org and app stores: the org the report is of, whichever target is picked
 * now, and only when the load changed that org.
 */

const api = vi.hoisted(() => ({
  postMessage: vi.fn(),
  getState: () => undefined,
  setState: () => undefined,
}));

vi.mock('../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => api,
  getVscodeApi: () => api,
}));

import { FrozenLoadTab } from './FrozenLoadTab';

const STATUS: FrozenStatusInfo = {
  configured: true,
  sasDir: '/sas',
  datasetDir: '/sas/dataset',
  salt: { present: true, fingerprint: 'abc123def456' },
  mockDetectionConfigured: true,
  selection: null,
  manifest: null,
  lastLoad: null,
  lastLoads: [],
  lastVerifies: [],
};

/** A load into `orgId` that inserted `inserted` accounts. */
function report(orgId: string, inserted: number): FrozenLoadReportInfo {
  return {
    status: 'completed',
    orgId,
    mode: { pilot: false, reload: false },
    startedAt: '2026-10-23T09:00:00.000Z',
    durationMs: 4_000,
    alignment: { excludedObjects: [], removals: [], adjustments: [], recordTypeIssues: [] },
    placeholders: [],
    requiredDefaults: [],
    perObject: [
      {
        objectApiName: 'Account',
        fromFiles: 3,
        inserted,
        reused: 3 - inserted,
        skippedDuplicates: [],
        failed: [],
      },
    ],
    pass2: { resolved: 0, unresolved: [] },
    personContact: { restored: 0, unresolved: [] },
    purge: { deleted: {}, deactivated: {}, failures: [] },
    mappingPath: '/sas/referenceid-mapping.json',
    contractPath: '/sas/contract.json',
  };
}

describe('FrozenLoadTab, Take a checkpoint now', () => {
  beforeEach(() => {
    useOrgStore.setState({
      orgs: [
        developerOrg({ id: 'org-qa', alias: 'QA-SANDBOX', orgType: 'Sandbox' }),
        developerOrg({ id: 'org-uat', alias: 'UAT-SANDBOX', orgType: 'Sandbox' }),
        productionOrg(),
      ],
      selectedOrgId: 'org-uat',
    });
    useAppStore.setState({ currentRoute: 'frozen', navigationIntent: null });
    useFrozenStore.setState({
      status: STATUS,
      targetOrgId: 'org-uat',
      progress: [],
      loadReport: report('org-qa', 3),
      verdict: null,
      lastError: null,
    });
  });
  afterEach(() => {
    useOrgStore.setState({ orgs: [], selectedOrgId: null });
    useFrozenStore.setState({ loadReport: null, targetOrgId: '' });
  });

  it('closes the report with a checkpoint of the org the load filled, not of the target picked since', () => {
    render(<FrozenLoadTab onRefetchStatus={vi.fn()} />);
    const offer = within(screen.getByTestId('frozen-load-report')).getByTestId(
      'frozen-report-checkpoint-now',
    );
    expect(offer).toHaveTextContent('keep QA-SANDBOX as it is now');
    fireEvent.click(within(offer).getByRole('button', { name: 'Take a checkpoint now' }));
    expect(useAppStore.getState().navigationIntent).toEqual({
      route: 'checkpoint',
      takeCheckpoint: true,
      targetOrgId: 'org-qa',
    });
    expect(useOrgStore.getState().selectedOrgId).toBe('org-qa');
  });

  it('offers one after a reload that only purged what earlier loads created', () => {
    useFrozenStore.setState({
      loadReport: {
        ...report('org-qa', 0),
        mode: { pilot: false, reload: true },
        purge: { deleted: { Account: 0 }, deactivated: { Contact: 2 }, failures: [] },
      },
    });
    render(<FrozenLoadTab onRefetchStatus={vi.fn()} />);
    expect(screen.getByTestId('frozen-report-checkpoint-now')).toBeInTheDocument();
  });

  it('offers none after a load that inserted and purged nothing', () => {
    useFrozenStore.setState({
      loadReport: {
        ...report('org-qa', 0),
        purge: { deleted: { Account: 0 }, deactivated: {}, failures: [] },
      },
    });
    render(<FrozenLoadTab onRefetchStatus={vi.fn()} />);
    expect(screen.getByTestId('frozen-load-report')).toBeInTheDocument();
    expect(screen.queryByTestId('frozen-report-checkpoint-now')).toBeNull();
  });

  it('offers none for a production org, which a checkpoint refuses', () => {
    useFrozenStore.setState({ loadReport: report('org-prod', 3) });
    render(<FrozenLoadTab onRefetchStatus={vi.fn()} />);
    expect(screen.getByTestId('frozen-load-report')).toBeInTheDocument();
    expect(screen.queryByTestId('frozen-report-checkpoint-now')).toBeNull();
  });

  describe('the checkpoint first', () => {
    const lastSent = (type: string): Record<string, unknown> | undefined => {
      const sent = api.postMessage.mock.calls
        .map((call) => (call[0] as { payload: { type: string; id: string } }).payload)
        .filter((message) => message.type === type);
      return sent[sent.length - 1];
    };

    beforeEach(() => {
      api.postMessage.mockClear();
      useFrozenStore.setState({
        loadReport: null,
        status: {
          ...STATUS,
          manifest: { source: { orgId: 'org-qa' } } as FrozenStatusInfo['manifest'],
        },
      });
    });

    it('is off, says the preview gives its cost, and goes with the preview and the load once ticked', () => {
      render(<FrozenLoadTab onRefetchStatus={vi.fn()} />);
      const toggle = screen.getByTestId('frozen-load-checkpoint-first-toggle');
      expect(toggle).not.toBeChecked();
      expect(screen.getByTestId('frozen-load-checkpoint-first-cost-said')).toHaveTextContent(
        'The load takes it with no question of its own',
      );

      fireEvent.click(toggle);
      fireEvent.click(screen.getByTestId('frozen-load-preview'));
      expect(lastSent('frozen:load:preview')?.payload).toMatchObject({ checkpointFirst: {} });

      fireEvent.click(screen.getByTestId('frozen-load-run'));
      expect(lastSent('frozen:load')?.payload).toMatchObject({ checkpointFirst: {} });
    });

    it('asks nothing of a load it is not ticked for', () => {
      render(<FrozenLoadTab onRefetchStatus={vi.fn()} />);
      fireEvent.click(screen.getByTestId('frozen-load-preview'));
      expect(lastSent('frozen:load:preview')?.payload).not.toHaveProperty('checkpointFirst');
      fireEvent.click(screen.getByTestId('frozen-load-run'));
      expect(lastSent('frozen:load')?.payload).not.toHaveProperty('checkpointFirst');
    });

    it('names the checkpoint on the load’s report, with the way to a rewind', () => {
      useFrozenStore.setState({
        loadReport: {
          ...report('org-qa', 3),
          checkpoint: {
            state: 'taken',
            checkpointId: 'ck-20261023-090000-a1b2',
            name: 'Before Frozen load 2026-10-23 09:00 UTC',
            takenAt: '2026-10-23T09:00:00.000Z',
            expiresAt: null,
            objects: ['Account'],
            records: 3,
            bytes: 2_048,
            requests: 8,
            added: [],
            notHeld: [],
          },
        },
      });
      render(<FrozenLoadTab onRefetchStatus={vi.fn()} />);

      expect(screen.getByTestId('frozen-load-report-checkpoint-taken')).toHaveTextContent(
        '“Before Frozen load 2026-10-23 09:00 UTC”, 3 records of Account.',
      );
      fireEvent.click(screen.getByRole('button', { name: 'Rewind to before this load…' }));
      expect(useAppStore.getState().navigationIntent).toEqual({
        route: 'checkpoint',
        previewCheckpointId: 'ck-20261023-090000-a1b2',
        targetOrgId: 'org-qa',
      });
    });

    it('says a load that wrote nothing deleted it, on its report', () => {
      useFrozenStore.setState({
        loadReport: {
          ...report('org-qa', 0),
          checkpoint: { state: 'deleted', deleted: 'nothingWritten' },
        },
      });
      render(<FrozenLoadTab onRefetchStatus={vi.fn()} />);
      expect(screen.getByTestId('frozen-load-report-checkpoint-deleted')).toHaveTextContent(
        'The checkpoint taken before the load was deleted: the load wrote nothing.',
      );
    });

    it('says what the error of a load it stopped says of its checkpoint', () => {
      render(<FrozenLoadTab onRefetchStatus={vi.fn()} />);
      fireEvent.click(screen.getByTestId('frozen-load-run'));
      const load = lastSent('frozen:load');
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            data: {
              id: 'err-1',
              type: 'frozen:load:error',
              timestamp: Date.now(),
              correlationId: load?.id,
              payload: {
                message: 'The mute was refused.',
                code: 'MUTE_REFUSED',
                checkpoint: { state: 'deleted', deleted: 'nothingWritten' },
              },
            },
          }),
        );
      });
      expect(screen.getByTestId('frozen-load-error-checkpoint-deleted')).toHaveTextContent(
        'The checkpoint taken before the load was deleted: the load wrote nothing.',
      );
    });

    it('says a load the user stopped in the interface’s words, with what it had written', () => {
      // The banner showed the host's English in every locale, object by object.
      render(<FrozenLoadTab onRefetchStatus={vi.fn()} />);
      fireEvent.click(screen.getByTestId('frozen-load-run'));
      const load = lastSent('frozen:load');
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            data: {
              id: 'err-3',
              type: 'frozen:load:error',
              timestamp: Date.now(),
              correlationId: load?.id,
              payload: {
                message:
                  'The load was cancelled after it had created 204 record(s) (Account: 3, ' +
                  'Opportunity: 1, Contact: 200). What it created is kept in the mapping: a ' +
                  'removal takes it back, and a reload purges it or finds it again.',
                code: 'LOAD_CANCELLED',
                written: 204,
              },
            },
          }),
        );
      });
      expect(screen.getByTestId('frozen-error')).toHaveTextContent(
        'You stopped the load part way. Records it had written by then, created or purged: 204.',
      );
      expect(screen.getByTestId('frozen-error')).not.toHaveTextContent('record(s)');
    });

    it('says what the sweep of a reload it stopped took, beside its error', () => {
      // Said in the audit trail alone, under a message that nothing was purged.
      render(<FrozenLoadTab onRefetchStatus={vi.fn()} />);
      fireEvent.click(screen.getByTestId('frozen-load-run'));
      const load = lastSent('frozen:load');
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            data: {
              id: 'err-2',
              type: 'frozen:load:error',
              timestamp: Date.now(),
              correlationId: load?.id,
              payload: {
                message:
                  'The load was cancelled before it created or purged a record: the mapping is left as it was.',
                code: 'LOAD_CANCELLED',
                sweeps: [
                  {
                    loadedAt: '2026-10-22T09:00:00.000Z',
                    result: {
                      status: 'cancelled',
                      objects: [
                        {
                          objectApiName: 'Task',
                          found: 230,
                          deleted: 200,
                          alreadyGone: 0,
                          keptChanged: 0,
                          refused: 0,
                          reasons: [],
                        },
                      ],
                      unread: [],
                      handWork: [],
                    },
                  },
                  { loadedAt: 'not a sweep' },
                ],
              },
            },
          }),
        );
      });
      const swept = screen.getByTestId('frozen-load-error-sweeps');
      expect(swept).toHaveTextContent('Before the load ended, its sweep had already done this:');
      expect(swept).toHaveTextContent('Swept for the load of 2026-10-22');
      expect(within(swept).getByTestId('forge-sweep-result-Task')).toHaveTextContent('200');
      expect(within(swept).getAllByTestId('forge-sweep-result')).toHaveLength(1);
    });

    it('says what the preview found it would hold and cost', () => {
      render(<FrozenLoadTab onRefetchStatus={vi.fn()} />);
      fireEvent.click(screen.getByTestId('frozen-load-checkpoint-first-toggle'));
      fireEvent.click(screen.getByTestId('frozen-load-preview'));
      const preview = lastSent('frozen:load:preview');
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            data: {
              id: 'resp-1',
              type: 'frozen:load:preview:response',
              timestamp: Date.now(),
              correlationId: preview?.id,
              payload: {
                plan: {
                  orgId: 'org-uat',
                  mode: { pilot: false, reload: false },
                  earlierLoads: 0,
                  perObject: [],
                  excludedObjects: [],
                  removals: [],
                  placeholders: [],
                  requiredDefaults: [],
                  personContacts: 0,
                  recordTypeIssues: 0,
                  checkpoint: {
                    state: 'planned',
                    estimate: {
                      records: 12,
                      apiRequests: 9,
                      apiRequestsLeft: 14_000,
                      seconds: 8,
                      bytes: 1_048_576,
                    },
                    objects: ['Account'],
                    added: [],
                    notHeld: [],
                    keepDays: 7,
                  },
                },
              },
            },
          }),
        );
      });
      expect(screen.getByTestId('frozen-preview-checkpoint-cost')).toHaveTextContent(
        'The load would take a checkpoint first: about 12 records of Account, 9 API requests, 8s, 1 MB on this machine, kept 7 days.',
      );
    });
  });
});
