import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import i18n from '../../i18n';
import { useOrgStore } from '../../stores/useOrgStore';
import { useSeedWizardStore } from '../../stores/useSeedWizardStore';
import { SeedSelectStep } from './SeedSelectStep';
import type { SeedObjectInfo } from './Step2_SelectObjects';
import type { SalesforceOrg } from '@sandforge/shared';
import { OrgSafetyTier, SEED_MAX_RECORDS_PER_OBJECT } from '@sandforge/shared';
import { uiLocale } from '../../utils/formatters';

vi.mock('../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => ({
    postMessage: vi.fn(),
    getState: () => undefined,
    setState: () => undefined,
  }),
  getVscodeApi: () => ({
    postMessage: vi.fn(),
    getState: () => undefined,
    setState: () => undefined,
  }),
}));

/* jsdom has no layout, so the real virtual list would render no object row. */
vi.mock('../../components/ui/VirtualList', () => ({
  VirtualList: <T,>({
    items,
    renderItem,
    keyExtractor,
  }: {
    items: T[];
    renderItem: (item: T, index: number) => React.ReactNode;
    keyExtractor: (item: T, index: number) => string;
  }) => (
    <div data-testid="virtual-list">
      {items.map((item, index) => (
        <div key={keyExtractor(item, index)}>{renderItem(item, index)}</div>
      ))}
    </div>
  ),
}));

const object = (apiName: string): SeedObjectInfo => ({
  apiName,
  label: apiName,
  recordCount: 0,
  dependencies: [],
});

function renderStep(
  availableObjects: SeedObjectInfo[] = [],
  volumes: Record<string, { count: number; batchSize: number }> = {},
) {
  render(
    <SeedSelectStep
      availableObjects={availableObjects}
      loadingObjects={false}
      volumes={volumes}
      onChangeVolume={vi.fn()}
    />,
  );
}

describe('SeedSelectStep record counts', () => {
  beforeEach(() => {
    useOrgStore.setState({ orgs: [], selectedOrgId: 'org-1' });
    useSeedWizardStore.setState({ selectedOrgId: 'org-1', selectedObjects: ['Account'] });
  });

  it('names each record-count field after its object', () => {
    // One field per selected object under a single "Record count" heading:
    // the heading names the list, not the twelfth field in it.
    renderStep();
    expect(screen.getByTestId('volume-Account').getAttribute('aria-label')).toContain('Account');
  });

  it('says by the field a count past what the host takes, which the run was refused for once sent', () => {
    renderStep([], { Account: { count: SEED_MAX_RECORDS_PER_OBJECT + 1, batchSize: 200 } });

    const field = screen.getByTestId('volume-Account');
    const said = screen.getByTestId('volume-Account-too-many');
    expect(field.getAttribute('max')).toBe(String(SEED_MAX_RECORDS_PER_OBJECT));
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(field.getAttribute('aria-describedby')).toBe(said.id);
    expect(said.textContent).toBe(
      i18n.t('seed.volumeTooMany', {
        object: 'Account',
        most: SEED_MAX_RECORDS_PER_OBJECT.toLocaleString(uiLocale()),
      }),
    );
  });

  it('says nothing by a count the host takes', () => {
    renderStep([], { Account: { count: SEED_MAX_RECORDS_PER_OBJECT, batchSize: 200 } });

    expect(screen.queryByTestId('volume-Account-too-many')).toBeNull();
    expect(screen.getByTestId('volume-Account').getAttribute('aria-invalid')).toBeNull();
  });

  it('shows neither a SOQL helper nor a personal-data warning between the objects and their counts', () => {
    // The helper's query was read by nothing in the seed, and the warning asked
    // to anonymize fields whose every value the run generates.
    renderStep([object('Account'), object('Contact')]);

    expect(screen.queryByTestId('nl2soql-helper')).toBeNull();
    expect(screen.queryByTestId('pii-scan-warning')).toBeNull();
    expect(screen.queryByText(/SOQL/)).toBeNull();
  });
});

describe('SeedSelectStep objects', () => {
  beforeEach(() => {
    useOrgStore.setState({ orgs: [], selectedOrgId: 'org-1' });
    useSeedWizardStore.setState({ selectedOrgId: 'org-1', selectedObjects: [] });
  });

  it('offers the account of a contact ticked without it, and adds it in one click', () => {
    renderStep([object('Invoice__c'), object('Contact'), object('Account')]);

    fireEvent.click(screen.getByTestId('obj-Contact'));
    expect(screen.getByTestId('seed-parent-suggestion-Account').textContent).toContain(
      'Contact records hang from Account',
    );

    fireEvent.click(screen.getByTestId('seed-add-parent-Account'));

    expect(useSeedWizardStore.getState().selectedObjects).toEqual(['Contact', 'Account']);
    expect(screen.queryByTestId('seed-parent-suggestions')).toBeNull();
  });
});

describe('SeedSelectStep org picker', () => {
  /** An org of `orgType` as the store holds it. */
  function org(id: string, alias: string, orgType: SalesforceOrg['orgType']): SalesforceOrg {
    return {
      id,
      alias,
      username: `${alias}@example.test`,
      instanceUrl: 'https://example.my.salesforce.com',
      orgId: id,
      orgType,
      authMethod: 'sfdx_import',
      safetyTier: OrgSafetyTier.LOW,
      appearance: { color: '#4a9eff', icon: 'cloud', position: 0 },
      metadata: { apiVersion: '62.0', edition: 'Developer Edition', features: [] },
      status: 'connected',
      lastConnected: '2026-09-01T08:00:00.000Z',
      tags: [],
    };
  }

  beforeEach(() => {
    useOrgStore.setState({
      orgs: [org('org-1', 'uat', 'Sandbox'), org('org-2', 'feature', 'Scratch')],
      selectedOrgId: 'org-1',
    });
    useSeedWizardStore.setState({ selectedOrgId: '', selectedObjects: [] });
  });

  it('offers each org under the type the org badges give it, a scratch org as one', () => {
    // Every org but a production one used to be offered as [SBX].
    renderStep();

    expect(screen.getByRole('option', { name: 'uat [SANDBOX]' })).toBeDefined();
    expect(screen.getByRole('option', { name: 'feature [SCRATCH]' })).toBeDefined();
    expect(screen.queryByText(/\[SBX\]/)).toBeNull();
  });
});
