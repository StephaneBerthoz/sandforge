import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import type {
  BaseMessage,
  ForgeConfig,
  ForgeGraph,
  ForgeGraphNode,
  ForgePlan,
} from '@sandforge/shared';
import '../../i18n';

const mockPostMessage = vi.fn();
const stableApi = {
  postMessage: (...args: unknown[]) => mockPostMessage(...args),
  getState: () => undefined,
  setState: () => undefined,
};
vi.mock('../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => stableApi,
  getVscodeApi: () => stableApi,
}));

import { useForgeStore } from '../../stores/useForgeStore';
import { ReviewControlsTab } from './ReviewControlsTab';

/*
 * Review's Controls tab writes into the run's config what the run already
 * supports and the page never showed: fields left out, a filter, fields
 * renamed, a cap, owners given to the target's users.
 */

const CONFIG: ForgeConfig = {
  inputMode: 'record',
  recordId: '001000000000001AAA',
  depth: 'direct',
  sourceOrgId: 'org-source',
  targetOrgId: 'org-target',
  anonymizePII: false,
  skipEmpty: false,
  batchSize: 'auto',
};

function node(objectApiName: string, overrides: Partial<ForgeGraphNode> = {}): ForgeGraphNode {
  return {
    objectApiName,
    recordCount: 10,
    fieldCount: 5,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level: 0,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 5,
    estimatedSizeMB: 0,
    estimatedApiCalls: 0,
    batchStrategy: 'auto',
    ...overrides,
  };
}

const GRAPH: ForgeGraph = {
  nodes: [node('Account'), node('Contact', { level: 1 }), node('Task', { included: false })],
  edges: [],
  totalRecords: 30,
  estimatedSizeMB: 0,
  estimatedDurationSeconds: 0,
};

const PLAN: ForgePlan = {
  waves: [],
  totalRecords: 20,
  totalApiCalls: 2,
  estimatedDurationSeconds: 1,
  cycleResolutions: [],
};

const OWNER = '005000000000001AAA';
const ADA = '005000000000101AAA';

function sentAll(type: string): Array<BaseMessage & { payload: Record<string, unknown> }> {
  return mockPostMessage.mock.calls
    .map(
      (call) =>
        (call[0] as { payload: BaseMessage & { payload: Record<string, unknown> } }).payload,
    )
    .filter((message) => message.type === type);
}

function answer(requestType: string, type: string, payload: unknown): void {
  const request = sentAll(requestType).pop();
  if (!request) throw new Error(`no '${requestType}' was sent`);
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          id: `resp-${type}`,
          type,
          timestamp: Date.now(),
          correlationId: request.id,
          payload,
        },
      }),
    );
  });
}

/** Pick `object` and answer the read of its fields in both orgs. */
function pickObject(object: string): void {
  fireEvent.change(screen.getByTestId('controls-object'), { target: { value: object } });
  answer('sync:describe-fields', 'sync:describe-fields:response', {
    objectApiName: object,
    sourceFields: [
      { apiName: 'Description', label: 'Description', type: 'textarea' },
      { apiName: 'Region__c', label: 'Region', type: 'string' },
      { apiName: 'Fax', label: 'Fax', type: 'phone' },
    ],
    targetFields: [
      { apiName: 'Area__c', label: 'Area', type: 'string' },
      { apiName: 'Description', label: 'Description', type: 'textarea' },
    ],
  });
}

const config = (): ForgeConfig => useForgeStore.getState().config!;

describe('ReviewControlsTab', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
    useForgeStore.getState().reset();
    useForgeStore.getState().setConfig(CONFIG);
    useForgeStore.getState().setGraph(GRAPH);
    useForgeStore.getState().setPlan(PLAN);
    render(<ReviewControlsTab />);
    answer('forge:users:request', 'forge:users:response', {
      orgId: 'org-target',
      users: [{ id: ADA, name: 'Ada Admin', username: 'ada@example.invalid' }],
      truncated: false,
    });
  });

  it('lists the objects the run writes, and reads the fields of the one picked in both orgs', () => {
    const options = within(screen.getByTestId('controls-object')).getAllByRole('option');
    expect(options.map((o) => o.textContent).slice(1)).toEqual(['Account', 'Contact']);

    pickObject('Account');

    expect(sentAll('sync:describe-fields').map((m) => m.payload)).toEqual([
      { sourceOrgId: 'org-source', targetOrgId: 'org-target', objectApiName: 'Account' },
    ]);
    expect(screen.getByTestId('controls-field-Region__c')).toBeTruthy();
  });

  it('leaves a field out of the rows and takes it back, keeping the plan Review read', () => {
    pickObject('Account');
    fireEvent.click(screen.getByTestId('controls-field-Description'));

    expect(config().fieldExclusions).toEqual({ Account: ['Description'] });
    expect(useForgeStore.getState().plan).toBe(PLAN);
    expect(screen.getByTestId('controls-said').textContent).toBe('Kept with the run.');

    fireEvent.click(screen.getByTestId('controls-field-Description'));
    expect(config()).not.toHaveProperty('fieldExclusions');
  });

  it('narrows the fields listed by a search', () => {
    pickObject('Account');
    fireEvent.change(screen.getByTestId('controls-fields-search'), { target: { value: 'reg' } });

    expect(screen.queryByTestId('controls-field-Description')).toBeNull();
    expect(screen.getByTestId('controls-field-Region__c')).toBeTruthy();
  });

  it('holds an object to a filter the schema takes, and refuses one it would refuse', () => {
    pickObject('Contact');
    const where = screen.getByTestId('controls-filter-where');

    fireEvent.change(where, { target: { value: 'Email != null -- all' } });
    fireEvent.click(screen.getByTestId('controls-filter-apply'));
    expect(screen.getByTestId('controls-filter-refused').textContent).toContain('512 characters');
    expect(where.getAttribute('aria-invalid')).toBe('true');
    expect(config()).not.toHaveProperty('objectSoqlFilters');

    fireEvent.change(where, { target: { value: 'Email != null' } });
    fireEvent.click(screen.getByTestId('controls-filter-apply'));
    expect(config().objectSoqlFilters).toEqual({ Contact: 'Email != null' });

    fireEvent.click(screen.getByTestId('controls-filter-clear'));
    expect(config()).not.toHaveProperty('objectSoqlFilters');
  });

  it('keeps the filter a run of a query reads its root by, as the query set it', () => {
    act(() =>
      useForgeStore.getState().updateConfig((c) => ({
        ...c,
        inputMode: 'soql',
        recordId: undefined,
        soqlQuery: "SELECT Id FROM Account WHERE Industry = 'Energy'",
        objectSoqlFilters: { Account: "Industry = 'Energy'" },
      })),
    );
    pickObject('Account');

    expect((screen.getByTestId('controls-filter-where') as HTMLTextAreaElement).readOnly).toBe(
      true,
    );
    expect(screen.queryByTestId('controls-filter-apply')).toBeNull();
    expect(screen.getByTestId('controls-filter').textContent).toContain('change it in the query');
  });

  it('writes a source field under a target field, and under its own name again', () => {
    pickObject('Account');
    fireEvent.change(screen.getByTestId('controls-rename-from'), {
      target: { value: 'Region__c' },
    });
    fireEvent.change(screen.getByTestId('controls-rename-to'), { target: { value: 'Area__c' } });
    fireEvent.click(screen.getByTestId('controls-rename-add'));

    expect(config().fieldMappings).toEqual({ Account: { Region__c: 'Area__c' } });
    const item = screen.getByTestId('controls-rename-Region__c');
    expect(item.textContent).toContain('Region__c written as Area__c');

    fireEvent.click(within(item).getByRole('button'));
    expect(config()).not.toHaveProperty('fieldMappings');
  });

  it('caps every object’s records at one of the caps the form offers, and lifts it', () => {
    const cap = screen.getByTestId('controls-cap-value');
    expect(
      within(cap)
        .getAllByRole('option')
        .map((o) => o.getAttribute('value')),
    ).toEqual(['', '10', '50', '100', '500', '1000']);

    fireEvent.change(cap, { target: { value: '50' } });
    expect(config().maxRecordsPerObject).toBe(50);
    expect(useForgeStore.getState().plan).toBe(PLAN);

    fireEvent.change(cap, { target: { value: '' } });
    expect(config()).not.toHaveProperty('maxRecordsPerObject');
  });

  it('lists a cap the run holds that the form does not offer, as it stands', () => {
    act(() => useForgeStore.getState().updateConfig((c) => ({ ...c, maxRecordsPerObject: 200 })));

    const cap = screen.getByTestId('controls-cap-value') as HTMLSelectElement;
    expect(cap.value).toBe('200');
    expect(
      within(cap)
        .getAllByRole('option')
        .map((o) => o.getAttribute('value')),
    ).toContain('200');
  });

  it("gives a source user's records to the target's user picked by name, keeping the ids", () => {
    expect(sentAll('forge:users:request').map((m) => m.payload)).toEqual([{ orgId: 'org-target' }]);
    const target = screen.getByTestId('controls-owner-target');
    expect(
      within(target)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Pick…', 'Ada Admin — ada@example.invalid']);

    fireEvent.change(screen.getByTestId('controls-owner-source'), { target: { value: OWNER } });
    fireEvent.change(target, { target: { value: ADA } });
    fireEvent.click(screen.getByTestId('controls-owner-add'));

    expect(config().ownerMappings).toEqual({ [OWNER]: ADA });
    const item = screen.getByTestId(`controls-owner-${OWNER}`);
    expect(item.textContent).toContain(`${OWNER} given to Ada Admin (${ADA})`);

    fireEvent.click(within(item).getByRole('button'));
    expect(config()).not.toHaveProperty('ownerMappings');
  });

  it('refuses an owner whose id is none, and writes nothing', () => {
    fireEvent.change(screen.getByTestId('controls-owner-source'), {
      target: { value: 'not an id' },
    });
    fireEvent.change(screen.getByTestId('controls-owner-target'), { target: { value: ADA } });
    fireEvent.click(screen.getByTestId('controls-owner-add'));

    expect(config()).not.toHaveProperty('ownerMappings');
    expect(screen.getByTestId('controls-refused').textContent).toContain('15 or 18 letters');
  });

  it('says the list of users was cut when the target holds more than it carries', () => {
    expect(screen.queryByTestId('controls-users-truncated')).toBeNull();
    mockPostMessage.mockClear();
    act(() => useForgeStore.getState().updateConfig((c) => ({ ...c, targetOrgId: 'org-big' })));
    answer('forge:users:request', 'forge:users:response', {
      orgId: 'org-big',
      users: [{ id: ADA, name: 'Ada Admin', username: 'ada@example.invalid' }],
      truncated: true,
    });

    expect(screen.getByTestId('controls-users-truncated').textContent).toBe(
      'The target org holds more active users: the first 1 by name are listed.',
    );
  });

  it("says when the target's users could not be read", () => {
    mockPostMessage.mockClear();
    act(() => useForgeStore.getState().updateConfig((c) => ({ ...c, targetOrgId: 'org-other' })));
    answer('forge:users:request', 'forge:users:error', {
      message: 'INVALID_SESSION_ID',
      code: 'USERS_ERROR',
      retryable: false,
    });

    expect(screen.getByTestId('controls-users-error').textContent).toContain('INVALID_SESSION_ID');
  });
});
