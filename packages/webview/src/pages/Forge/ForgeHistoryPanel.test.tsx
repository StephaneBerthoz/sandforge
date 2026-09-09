import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ForgeExecutionResult, ForgeGraph } from '@sandforge/shared';
import '../../i18n';
import { ForgeHistoryPanel } from './ForgeHistoryPanel';

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
