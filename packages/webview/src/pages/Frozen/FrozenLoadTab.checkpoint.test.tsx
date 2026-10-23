import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
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
});
