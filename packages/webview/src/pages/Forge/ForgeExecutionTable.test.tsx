import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, within } from '@testing-library/react';
import type { ForgeGraph, ForgeGraphNode } from '@sandforge/shared';
import '../../i18n';
import { useForgeStore } from '../../stores/useForgeStore';
import { ForgeExecutionTable } from './ForgeExecutionTable';

/**
 * How many components have drawn themselves: each one the table draws — the
 * table and each row — reads its words once per render.
 */
const renders = vi.hoisted(() => ({ count: 0 }));
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: (...args: Parameters<typeof actual.useTranslation>) => {
      renders.count += 1;
      return actual.useTranslation(...args);
    },
  };
});

function node(objectApiName: string, overrides: Partial<ForgeGraphNode> = {}): ForgeGraphNode {
  return {
    objectApiName,
    recordCount: 1200,
    fieldCount: 40,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level: 1,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 30,
    estimatedSizeMB: 0.1,
    estimatedApiCalls: 1,
    batchStrategy: 'auto',
    ...overrides,
  };
}

/** A run under way: an account written, its contacts being written, the rest to come. */
const GRAPH: ForgeGraph = {
  nodes: [
    node('Account', { status: 'done', progress: 100, level: 0 }),
    node('Contact', { status: 'running', progress: 42, piiFields: ['Email', 'Phone'] }),
    node('Case', { recordCount: 0, fieldCount: 0, createableFieldCount: 0 }),
    node('Lead', { included: false, leftOutByUser: true }),
    node('Asset', { status: 'error', errors: ['NOACCESS', 'INVALID_TYPE'] }),
  ],
  edges: [],
  totalRecords: 4800,
  estimatedSizeMB: 0.5,
  estimatedDurationSeconds: 20,
};

/** The row of `objectApiName`. */
function row(objectApiName: string): HTMLElement {
  const header = screen.getByRole('rowheader', { name: new RegExp(`^${objectApiName}`) });
  return header.closest('tr') as HTMLElement;
}

/** The extension saying where the run stands on one object. */
function progress(payload: Record<string, unknown>): void {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'forge:progress', id: 'p', correlationId: 'wv-run-1', payload },
      }),
    );
  });
}

describe('ForgeExecutionTable', () => {
  beforeEach(() => {
    const store = useForgeStore.getState();
    store.reset();
    store.setGraph(GRAPH);
    store.setPhase('execution');
    store.setExecutionRequestId('wv-run-1');
  });

  it('lists every object of the run in the graph’s order', () => {
    render(<ForgeExecutionTable />);

    expect(
      screen.getAllByRole('rowheader').map((header) => header.textContent?.replace('left out', '')),
    ).toEqual(['Account', 'Contact', 'Case', 'Lead', 'Asset']);
  });

  it('says what each node says: its status in words, and how far it has gone while written', () => {
    render(<ForgeExecutionTable />);

    expect(screen.getByTestId('forge-execution-status-Account').textContent).toBe('Done');
    expect(screen.getByTestId('forge-execution-status-Contact').textContent).toBe('Running');
    expect(screen.getByTestId('forge-execution-status-Asset').textContent).toBe('Failed');
    expect(within(row('Contact')).getByRole('progressbar').getAttribute('aria-valuenow')).toBe(
      '42',
    );
    expect(row('Contact').textContent).toContain('42%');
    // A bar is drawn only while an object is written.
    expect(within(row('Account')).queryByRole('progressbar')).toBeNull();
  });

  it('gives the counts the nodes give: records, fields, personal fields and errors', () => {
    render(<ForgeExecutionTable />);

    expect(screen.getByTestId('forge-execution-records-Account').textContent).toBe('1,200');
    expect(row('Account').textContent).toContain('40 fields (30 cloneable)');
    expect(row('Contact').textContent).toContain('2');
    expect(row('Asset').textContent).toContain('2');
    // Never measured: said so, rather than zeroes.
    expect(screen.getByTestId('forge-execution-records-Case').textContent).toBe(
      'Size not measured yet',
    );
  });

  it('marks the objects the run leaves out, as the dashed outline marks them on the graph', () => {
    render(<ForgeExecutionTable />);

    expect(row('Lead').querySelector('th')?.textContent).toBe('Leadleft out');
    expect(row('Account').querySelector('th')?.textContent).toBe('Account');
  });

  it('follows each progress event, with the counts the run read', () => {
    render(<ForgeExecutionTable />);

    progress({
      objectName: 'Case',
      status: 'running',
      progress: 30,
      recordCount: 7,
      fieldCount: 25,
    });

    expect(screen.getByTestId('forge-execution-status-Case').textContent).toBe('Running');
    expect(row('Case').textContent).toContain('30%');
    expect(screen.getByTestId('forge-execution-records-Case').textContent).toBe('7');
  });

  it('draws again the row a progress event is about, and nothing else', () => {
    render(<ForgeExecutionTable />);
    renders.count = 0;

    progress({ objectName: 'Contact', status: 'running', progress: 80 });

    expect(row('Contact').textContent).toContain('80%');
    expect(renders.count).toBe(1);
  });
});
