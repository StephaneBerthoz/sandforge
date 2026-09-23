import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import type {
  BaseMessage,
  ForgeExecutionResult,
  ForgeGraph,
  ForgeUndoResult,
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

import { ForgeHistoryPanel } from './ForgeHistoryPanel';
import { useOrgStore } from '../../stores/useOrgStore';

/**
 * The re-use affordance over the runs the extension persisted.
 *
 * History was write-only: the last 20 runs were stored with the config that
 * produced them and no screen could replay one. Each entry here refills the
 * Forge form — it does not launch a clone, because Forge runs discover ->
 * plan -> execute and the user confirms the plan before anything is written.
 *
 * Entries are whole `ForgeExecutionResult` values: an entry the extension
 * writes carries a full graph, an id-remap table and per-object errors, and
 * a three-field stub would not catch a component reading a field that a real
 * reply shapes differently.
 */

const GRAPH: ForgeGraph = {
  nodes: [
    {
      objectApiName: 'Account',
      recordCount: 120,
      fieldCount: 68,
      status: 'done',
      progress: 100,
      included: true,
      piiFields: ['Phone'],
      anonymizeFields: ['Phone'],
      level: 0,
      successCount: 120,
      failureCount: 0,
      errors: [],
      createableFieldCount: 54,
      estimatedSizeMB: 0.4,
      estimatedApiCalls: 2,
      batchStrategy: 'auto',
    },
    {
      objectApiName: 'Contact',
      recordCount: 310,
      fieldCount: 74,
      status: 'done',
      progress: 100,
      included: true,
      piiFields: ['Email'],
      anonymizeFields: ['Email'],
      level: 1,
      successCount: 305,
      failureCount: 5,
      errors: ['REQUIRED_FIELD_MISSING: LastName'],
      createableFieldCount: 61,
      estimatedSizeMB: 1.1,
      estimatedApiCalls: 4,
      batchStrategy: 'bulk',
    },
  ],
  edges: [
    {
      sourceObject: 'Account',
      targetObject: 'Contact',
      relationshipName: 'Contacts',
      type: 'lookup',
    },
  ],
  totalRecords: 430,
  estimatedSizeMB: 1.5,
  estimatedDurationSeconds: 88,
  truncated: false,
};

const RECORD_RUN: ForgeExecutionResult = {
  forgeId: 'forge-record',
  status: 'partial',
  graph: GRAPH,
  duration: 96_413,
  timestamp: '2026-03-01T09:24:00.000Z',
  idRemapCount: 425,
  idRemapTable: { '0011t00000AbCdEAAV': '0015g00000ZzXyWAAV' },
  errors: [
    {
      objectApiName: 'Contact',
      stage: 'insert',
      failedCount: 5,
      attemptedCount: 310,
      samples: [
        {
          recordSummary: 'FirstName=Ada LastName= Email=ada@example.com',
          messages: ['REQUIRED_FIELD_MISSING: Required fields are missing: [LastName]'],
        },
      ],
    },
  ],
  config: {
    inputMode: 'record',
    recordId: '0011t00000AbCdEAAV',
    depth: 'custom',
    customDepth: 4,
    anonymizePII: true,
    skipEmpty: true,
    expandOrphanParents: true,
    maxRecordsPerObject: 100,
    batchSize: 'auto',
  },
};

const SOQL_RUN: ForgeExecutionResult = {
  forgeId: 'forge-soql',
  status: 'success',
  graph: GRAPH,
  duration: 41_002,
  timestamp: '2026-02-14T17:02:00.000Z',
  idRemapCount: 120,
  idRemapTable: {},
  errors: [],
  config: {
    inputMode: 'soql',
    soqlQuery: 'SELECT Id, Name FROM Account',
    depth: 'direct',
    anonymizePII: false,
    skipEmpty: false,
    expandOrphanParents: false,
    maxRecordsPerObject: 200,
    batchSize: 'auto',
  },
};

/** Written before configs were persisted — inspectable, not repeatable. */
const LEGACY_RUN: ForgeExecutionResult = {
  forgeId: 'forge-legacy',
  status: 'failure',
  graph: GRAPH,
  duration: 12_000,
  timestamp: '2025-11-30T08:00:00.000Z',
  idRemapCount: 0,
};

describe('ForgeHistoryPanel', () => {
  it('stays out of the form when there is no run and nothing went wrong', () => {
    const { container } = render(
      <ForgeHistoryPanel entries={[]} error={null} onReuseConfig={vi.fn()} />,
    );

    expect(container.firstChild).toBeNull();
  });

  it('says so when the history could not be loaded', () => {
    render(<ForgeHistoryPanel entries={[]} error="bridge timed out" onReuseConfig={vi.fn()} />);

    expect(screen.getByTestId('forge-history-error').textContent).toBe(
      'Run history could not be loaded.',
    );
  });

  it('lists one row per run, with what it was run from', () => {
    render(
      <ForgeHistoryPanel
        entries={[RECORD_RUN, SOQL_RUN, LEGACY_RUN]}
        error={null}
        onReuseConfig={vi.fn()}
      />,
    );

    expect(screen.getByTestId('forge-history-entry-forge-record').textContent).toContain(
      '0011t00000AbCdEAAV',
    );
    expect(screen.getByTestId('forge-history-entry-forge-record').textContent).toContain(
      'Custom depth',
    );
    expect(screen.getByTestId('forge-history-entry-forge-soql').textContent).toContain(
      'SELECT Id, Name FROM Account',
    );
    expect(screen.getByTestId('forge-history-entry-forge-record').textContent).toMatch(
      /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/,
    );
    expect(screen.getByTestId('forge-history-entry-forge-legacy')).toBeDefined();
  });

  it('hands the stored configuration back when a run is re-used', () => {
    const onReuseConfig = vi.fn();
    render(
      <ForgeHistoryPanel
        entries={[RECORD_RUN, SOQL_RUN]}
        error={null}
        onReuseConfig={onReuseConfig}
      />,
    );

    fireEvent.click(screen.getByTestId('forge-history-rerun-forge-soql'));

    expect(onReuseConfig).toHaveBeenCalledTimes(1);
    // The whole stored config, not the fields the panel happens to display.
    expect(onReuseConfig).toHaveBeenCalledWith(SOQL_RUN.config);
  });

  it('confirms the refill instead of leaving the button silent', () => {
    render(<ForgeHistoryPanel entries={[RECORD_RUN]} error={null} onReuseConfig={vi.fn()} />);

    expect(screen.queryByTestId('forge-history-reused')).toBeNull();
    fireEvent.click(screen.getByTestId('forge-history-rerun-forge-record'));

    const confirmation = screen.getByTestId('forge-history-reused');
    expect(confirmation.getAttribute('role')).toBe('status');
    expect(confirmation.textContent).toMatch(/^Form refilled from the run of \d{4}-\d{2}-\d{2}/);
  });

  it('cannot re-use a run recorded before configurations were kept', () => {
    const onReuseConfig = vi.fn();
    render(<ForgeHistoryPanel entries={[LEGACY_RUN]} error={null} onReuseConfig={onReuseConfig} />);

    const button = screen.getByTestId('forge-history-rerun-forge-legacy') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('title')).toBe(
      'Recorded before run configurations were kept — nothing to refill.',
    );

    fireEvent.click(button);
    expect(onReuseConfig).not.toHaveBeenCalled();
  });

  it('shows each run its own outcome', () => {
    render(
      <ForgeHistoryPanel
        entries={[RECORD_RUN, SOQL_RUN, LEGACY_RUN]}
        error={null}
        onReuseConfig={vi.fn()}
      />,
    );

    expect(screen.getByTestId('forge-history-entry-forge-record').textContent).toContain('Partial');
    expect(screen.getByTestId('forge-history-entry-forge-soql').textContent).toContain('Success');
    expect(screen.getByTestId('forge-history-entry-forge-legacy').textContent).toContain('Failed');
  });
});

/** A fake record id: the object's prefix, then a counter. */
const rid = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;
const sid = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}SRC`;

/** The sandbox the removable run wrote to, as the org store knows it. */
const DEV = { id: 'org-dev', alias: 'DEV-SANDBOX', username: 'dev@example.com' } as SalesforceOrg;

/** A run that created an account and two contacts, and linked an account the org held. */
const REMOVABLE_RUN: ForgeExecutionResult = {
  ...SOQL_RUN,
  forgeId: 'forge-removable',
  createdCount: 3,
  linkedExistingCount: 1,
  idRemapTable: {
    [sid('001', 1)]: rid('001', 1),
    [sid('001', 2)]: rid('001', 9),
    [sid('003', 1)]: rid('003', 1),
    [sid('003', 2)]: rid('003', 2),
  },
  idRemapExisting: [sid('001', 2)],
  idRemapCreated: [
    { objectApiName: 'Account', sourceIds: [sid('001', 1)] },
    { objectApiName: 'Contact', sourceIds: [sid('003', 1), sid('003', 2)] },
  ],
  targetOrgId: DEV.id,
};

/** What the extension answers once a contact was removed and the rest kept. */
const PARTIAL_ANSWER: ForgeUndoResult = {
  forgeId: 'forge-removable',
  status: 'partial',
  includeChanged: false,
  finishedAt: '2026-09-23T10:00:00.000Z',
  objects: [
    {
      objectApiName: 'Contact',
      planned: 2,
      deleted: 1,
      alreadyGone: 0,
      keptChanged: 1,
      keptDependents: 0,
      refused: 0,
      heldBy: [],
      unchecked: [],
      reasons: [],
    },
    {
      objectApiName: 'Account',
      planned: 1,
      deleted: 0,
      alreadyGone: 0,
      keptChanged: 0,
      keptDependents: 1,
      refused: 0,
      heldBy: ['Contact'],
      unchecked: [],
      reasons: [],
    },
  ],
};

/** The last message of `type` the panel sent through the bridge. */
function sent(type: string): (BaseMessage & { payload: Record<string, unknown> }) | undefined {
  return mockPostMessage.mock.calls
    .map(
      (call) =>
        (call[0] as { payload: BaseMessage & { payload: Record<string, unknown> } }).payload,
    )
    .filter((message) => message.type === type)
    .pop();
}

/** Answer the panel's `forge:undo`, correlated to it as the handler does. */
function answerRemoval(type: string, payload: unknown): void {
  const request = sent('forge:undo');
  if (!request) throw new Error("no 'forge:undo' was sent");
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

/** Open the confirmation of the removable run and type the org's name into it. */
function confirmRemoval(options: { includeChanged?: boolean } = {}): void {
  fireEvent.click(screen.getByTestId('forge-history-remove-forge-removable'));
  if (options.includeChanged) {
    fireEvent.click(screen.getByTestId('forge-removal-include-changed'));
  }
  fireEvent.change(screen.getByTestId('danger-input'), { target: { value: DEV.alias } });
  fireEvent.click(screen.getByTestId('danger-confirm-btn'));
}

describe('ForgeHistoryPanel — removing the records a run created', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
    useOrgStore.setState({ orgs: [DEV] });
  });

  it('offers the removal for a run that created records', () => {
    render(<ForgeHistoryPanel entries={[REMOVABLE_RUN]} error={null} onReuseConfig={vi.fn()} />);

    expect(screen.getByTestId('forge-history-remove-forge-removable').textContent).toBe(
      'Remove the records this run created',
    );
  });

  it('names the org and the records per object, children first, and keeps the linked ones', () => {
    render(<ForgeHistoryPanel entries={[REMOVABLE_RUN]} error={null} onReuseConfig={vi.fn()} />);

    fireEvent.click(screen.getByTestId('forge-history-remove-forge-removable'));

    const dialog = screen.getByRole('dialog');
    expect(screen.getByTestId('danger-title').textContent).toBe(
      "Remove this run's records from DEV-SANDBOX",
    );
    expect(dialog.textContent).toContain(
      'Records the run linked to, which DEV-SANDBOX already held, are kept, and so is a record that records staying in DEV-SANDBOX depend on.',
    );
    expect(dialog.textContent).toContain(
      'A record changed since the run ended, or one that records added since depend on, is kept unless you include it below.',
    );
    expect(
      within(screen.getByTestId('forge-removal-plan'))
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Contact: 2 records', 'Account: 1 record']);
    expect(screen.getByTestId('forge-removal-linked').textContent).toBe('1 linked record is kept.');
    // Nothing leaves before the org's name is typed.
    expect(sent('forge:undo')).toBeUndefined();
  });

  it('sends the run, never its records, once the org name is typed', () => {
    render(<ForgeHistoryPanel entries={[REMOVABLE_RUN]} error={null} onReuseConfig={vi.fn()} />);

    confirmRemoval();

    expect(sent('forge:undo')?.payload).toEqual({
      forgeId: 'forge-removable',
      includeChanged: false,
    });
  });

  it('asks for the records changed since the run too when the box is ticked', () => {
    render(<ForgeHistoryPanel entries={[REMOVABLE_RUN]} error={null} onReuseConfig={vi.fn()} />);

    confirmRemoval({ includeChanged: true });

    expect(sent('forge:undo')?.payload).toEqual({
      forgeId: 'forge-removable',
      includeChanged: true,
    });
  });

  it('shows what the removal did per object, and reads the history again', () => {
    const onHistoryChanged = vi.fn();
    render(
      <ForgeHistoryPanel
        entries={[REMOVABLE_RUN]}
        error={null}
        onReuseConfig={vi.fn()}
        onHistoryChanged={onHistoryChanged}
      />,
    );
    confirmRemoval();

    answerRemoval('forge:undo:response', { result: PARTIAL_ANSWER, operationId: 'forge-undo-7' });

    const result = screen.getByTestId('forge-removal-result');
    expect(within(result).getByRole('heading').textContent).toBe(
      'Records this run created were removed from DEV-SANDBOX; the others stay, as listed.',
    );
    expect(screen.getByTestId('forge-removal-result-Contact').textContent).toBe(
      'Contact: 1 deleted · 1 kept, changed since the run',
    );
    expect(screen.getByTestId('forge-removal-result-Account').textContent).toBe(
      'Account: 1 kept, records of Contact that stay depend on it',
    );
    expect(onHistoryChanged).toHaveBeenCalledTimes(1);
  });

  it("lists the org's reasons under the object it refused", () => {
    render(<ForgeHistoryPanel entries={[REMOVABLE_RUN]} error={null} onReuseConfig={vi.fn()} />);
    confirmRemoval();

    answerRemoval('forge:undo:response', {
      operationId: 'forge-undo-7',
      result: {
        ...PARTIAL_ANSWER,
        status: 'failure',
        objects: [
          {
            ...PARTIAL_ANSWER.objects[0],
            deleted: 0,
            keptChanged: 0,
            refused: 2,
            reasons: ['DELETE_FAILED: Your attempt to delete this record could not be completed.'],
          },
        ],
      },
    });

    const contact = screen.getByTestId('forge-removal-result-Contact');
    expect(contact.textContent).toContain('2 refused');
    expect(within(contact).getByRole('listitem').textContent).toBe(
      'DELETE_FAILED: Your attempt to delete this record could not be completed.',
    );
  });

  it('shows a refusal of the whole removal under the run', () => {
    render(<ForgeHistoryPanel entries={[REMOVABLE_RUN]} error={null} onReuseConfig={vi.fn()} />);
    confirmRemoval();

    answerRemoval('forge:undo:error', {
      message: 'Operation blocked by Production Guard: delete is not allowed on production org',
      code: 'GUARD_BLOCKED',
      retryable: false,
    });

    expect(screen.getByTestId('forge-history-remove-error').textContent).toContain(
      'Operation blocked by Production Guard',
    );
  });

  it('does not offer it twice: a run whose records were removed says when', () => {
    render(
      <ForgeHistoryPanel
        entries={[
          {
            ...REMOVABLE_RUN,
            undo: {
              removedAt: '2026-09-23T10:00:00.000Z',
              deleted: 2,
              alreadyGone: 0,
              kept: 1,
              refused: 0,
            },
          },
        ]}
        error={null}
        onReuseConfig={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('forge-history-remove-forge-removable')).toBeNull();
    expect(screen.getByTestId('forge-removal-mark').textContent).toMatch(
      /^Records removed on \d{4}-\d{2}-\d{2} \d{2}:\d{2}: 2 deleted · 1 kept$/,
    );
  });

  it('says why a run recorded before runs kept what they created offers none', () => {
    render(<ForgeHistoryPanel entries={[RECORD_RUN]} error={null} onReuseConfig={vi.fn()} />);

    expect(screen.queryByTestId('forge-history-remove-forge-record')).toBeNull();
    expect(screen.getByTestId('forge-history-remove-unrecorded-forge-record').textContent).toBe(
      'Recorded before runs kept what they created: its records cannot be removed from here.',
    );
  });

  it('says why a run whose org is no longer registered offers none', () => {
    useOrgStore.setState({ orgs: [] });
    render(<ForgeHistoryPanel entries={[REMOVABLE_RUN]} error={null} onReuseConfig={vi.fn()} />);

    expect(screen.queryByTestId('forge-history-remove-forge-removable')).toBeNull();
    expect(screen.getByTestId('forge-history-remove-org-gone-forge-removable')).toBeDefined();
  });

  it('offers nothing, and says nothing, for a run that created no record', () => {
    render(
      <ForgeHistoryPanel
        entries={[{ ...REMOVABLE_RUN, idRemapCreated: [], createdCount: 0 }]}
        error={null}
        onReuseConfig={vi.fn()}
      />,
    );

    const entry = screen.getByTestId('forge-history-entry-forge-removable');
    expect(within(entry).queryByRole('button', { name: /Remove/ })).toBeNull();
    expect(screen.queryByTestId('forge-history-remove-unrecorded-forge-removable')).toBeNull();
  });
});
