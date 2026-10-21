import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '../../i18n';
import type { SeedExecutionResult } from '@sandforge/shared';
import { SeedOpenRecord, recordToOpen } from './SeedOpenRecord';

const mockPostMessage = vi.fn();
const vscodeApi = {
  postMessage: mockPostMessage,
  getState: () => undefined,
  setState: () => undefined,
};

vi.mock('../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => vscodeApi,
  getVscodeApi: () => vscodeApi,
}));

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

function result(objects: Array<[string, string[]]>): SeedExecutionResult {
  return {
    templateId: 'tpl',
    operationId: 'op-7',
    status: 'success',
    objectResults: objects.map(([objectApiName, createdIds]) => ({
      objectApiName,
      recordsCreated: createdIds.length,
      recordsFailed: 0,
      createdIds,
      errors: [],
    })),
    totalRecordsCreated: objects.reduce((sum, [, ids]) => sum + ids.length, 0),
    totalRecordsFailed: 0,
    duration: 100,
    timestamp: '2026-10-01T00:00:00.000Z',
  };
}

/** The open-record requests sent, unwrapped from their envelope. */
function sent(): Array<{ id: string; payload: unknown }> {
  return mockPostMessage.mock.calls
    .map(
      ([envelope]) =>
        (envelope as { payload: { id: string; type: string; payload: unknown } }).payload,
    )
    .filter((message) => (message as { type: string }).type === 'seed:open-record');
}

/** Answer the last request as the extension does, on the channel named. */
function answer(type: string, payload: Record<string, unknown>): void {
  const request = sent().at(-1);
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { id: 'resp', type, correlationId: request?.id, timestamp: Date.now(), payload },
      }),
    );
  });
}

describe('recordToOpen', () => {
  it('chooses the first account the run created, wherever its object comes', () => {
    expect(
      recordToOpen(
        result([
          ['Contact', [fakeId('003', 1)]],
          ['Account', [fakeId('001', 1), fakeId('001', 2)]],
        ]),
      ),
    ).toEqual({ objectApiName: 'Account', id: fakeId('001', 1) });
  });

  it('chooses the first record of the first object that created one when no account was', () => {
    expect(
      recordToOpen(
        result([
          ['Account', []],
          ['Lead', [fakeId('00Q', 1)]],
        ]),
      ),
    ).toEqual({ objectApiName: 'Lead', id: fakeId('00Q', 1) });
  });

  it('chooses nothing when the run listed no record it created', () => {
    expect(recordToOpen(result([['Account', []]]))).toBeNull();
  });
});

describe('SeedOpenRecord', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
  });

  it('names the record by the run and its id, never by an address', () => {
    render(<SeedOpenRecord result={result([['Account', [fakeId('001', 1)]]])} orgName="dev1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Open a created Account in dev1' }));

    expect(sent().map((message) => message.payload)).toEqual([
      { runId: 'op-7', recordId: fakeId('001', 1) },
    ]);
  });

  it('names the record’s object by the label a describe gave it, else by its API name', () => {
    // "Open a created Invoice__c in dev1": the API name, suffix included, in
    // a sentence, where the org's own pages say Invoice.
    const { rerender } = render(
      <SeedOpenRecord
        result={result([['Invoice__c', [fakeId('a01', 1)]]])}
        orgName="dev1"
        objectLabels={new Map([['Invoice__c', 'Invoice']])}
      />,
    );
    expect(screen.getByTestId('btn-seed-open-record').textContent).toBe(
      'Open a created Invoice in dev1',
    );

    rerender(
      <SeedOpenRecord result={result([['Invoice__c', [fakeId('a01', 1)]]])} orgName="dev1" />,
    );
    expect(screen.getByTestId('btn-seed-open-record').textContent).toBe(
      'Open a created Invoice__c in dev1',
    );
  });

  it('says why the record did not open, whether the extension refused it or VS Code did not open it', () => {
    render(<SeedOpenRecord result={result([['Account', [fakeId('001', 1)]]])} orgName="dev1" />);

    fireEvent.click(screen.getByTestId('btn-seed-open-record'));
    answer('seed:open-record:error', {
      message: 'The org this run wrote to is no longer connected.',
      code: 'ORG_NOT_FOUND',
      retryable: false,
    });
    expect(screen.getByRole('alert').textContent).toBe(
      'The org this run wrote to is no longer connected.',
    );

    fireEvent.click(screen.getByTestId('btn-seed-open-record'));
    answer('seed:open-record:response', {
      status: 'error',
      message: 'VS Code did not open the page.',
    });
    expect(screen.getByRole('alert').textContent).toBe('VS Code did not open the page.');

    fireEvent.click(screen.getByTestId('btn-seed-open-record'));
    answer('seed:open-record:response', { status: 'opened' });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('draws nothing for a run that created nothing', () => {
    const { container } = render(
      <SeedOpenRecord result={result([['Account', []]])} orgName="dev1" />,
    );
    expect(container.innerHTML).toBe('');
  });
});
