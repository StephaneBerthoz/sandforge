import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import type { BaseMessage, ForgeExecutionResult, ForgeRunVerification } from '@sandforge/shared';
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

import { ForgeResultsVerify, ForgeVerificationView } from './ForgeResultsVerify';

/*
 * The verification of the run on screen, from its results: the run named,
 * never its records, and what the extension found said in place.
 */

const rid = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;
const sid = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}SRC`;

/** The run on screen: an account and two contacts created, an account linked to. */
const RUN: ForgeExecutionResult = {
  forgeId: 'forge-on-screen',
  status: 'success',
  graph: { nodes: [], edges: [], totalRecords: 0, estimatedSizeMB: 0, estimatedDurationSeconds: 0 },
  duration: 1000,
  timestamp: '2026-10-01T08:00:00.000Z',
  idRemapCount: 4,
  createdCount: 3,
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
};

/** A verification that found a contact deleted, a lookup moved, and an account changed. */
const PARTIAL: ForgeRunVerification = {
  verdict: 'partial',
  verifiedAt: '2026-10-01T09:00:00.000Z',
  attempts: 2,
  objects: [
    {
      objectApiName: 'Contact',
      expected: 2,
      present: 1,
      deleted: 1,
      notVisible: 0,
      changed: 0,
      changedRecords: [],
      deletedIds: [rid('003', 2)],
      notVisibleIds: [],
      linksChecked: 2,
      linksBroken: 1,
      brokenLinks: [
        {
          recordId: rid('003', 1),
          field: 'AccountId',
          expected: rid('001', 1),
          found: rid('001', 7),
        },
      ],
    },
    {
      objectApiName: 'Account',
      expected: 1,
      present: 1,
      deleted: 0,
      notVisible: 0,
      changed: 1,
      changedRecords: [{ recordId: rid('001', 1), modifiedAt: '2026-10-01T08:30:00.000+0000' }],
      deletedIds: [],
      notVisibleIds: [],
      linksChecked: 0,
      linksBroken: 0,
      brokenLinks: [],
    },
  ],
};

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

describe('ForgeResultsVerify', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
  });

  it('offers to verify what the run wrote, and says it writes nothing', () => {
    render(<ForgeResultsVerify run={RUN} />);
    const action = screen.getByTestId('forge-results-verify-run');
    expect(action.textContent).toBe('Verify what this run wrote');
    const hint = document.getElementById(action.getAttribute('aria-describedby') ?? '');
    expect(hint?.textContent).toContain('Nothing is written.');
  });

  it('offers nothing for a simulation, which wrote nothing', () => {
    render(<ForgeResultsVerify run={{ ...RUN, dryRun: true, wouldInsertCount: 3 }} />);
    expect(screen.queryByTestId('forge-results-verify')).toBeNull();
  });

  it('offers nothing for a run that created nothing, nor one kept before runs said what they created', () => {
    const { rerender } = render(<ForgeResultsVerify run={{ ...RUN, idRemapCreated: [] }} />);
    expect(screen.queryByTestId('forge-results-verify')).toBeNull();
    rerender(<ForgeResultsVerify run={{ ...RUN, idRemapCreated: undefined }} />);
    expect(screen.queryByTestId('forge-results-verify')).toBeNull();
  });

  it('sends the run, never its records, and says the target is being read', () => {
    render(<ForgeResultsVerify run={RUN} />);
    fireEvent.click(screen.getByTestId('forge-results-verify-run'));

    expect(sentAll('forge:verify:request').map((m) => m.payload)).toEqual([
      { forgeId: 'forge-on-screen' },
    ]);
    expect(screen.getByTestId('forge-results-verifying').textContent).toBe(
      'Verifying: the target is read again until two readings agree…',
    );
  });

  it('shows the verdict in place, then offers to verify again', () => {
    render(<ForgeResultsVerify run={RUN} />);
    fireEvent.click(screen.getByTestId('forge-results-verify-run'));
    answer('forge:verify:request', 'forge:verify:response', { verification: PARTIAL });

    expect(screen.getByTestId('forge-verification-verdict').textContent).toBe(
      'Partial: as listed below, a record is not there, a lookup does not hold, or a part could not be checked.',
    );
    expect(screen.getByTestId('forge-results-verify-run').textContent).toBe('Verify again');
    expect(screen.queryByTestId('forge-results-verifying')).toBeNull();
  });

  it('shows the verification the run already carries', () => {
    render(
      <ForgeResultsVerify run={{ ...RUN, verification: { ...PARTIAL, verdict: 'verified' } }} />,
    );
    expect(screen.getByTestId('forge-verification-verdict').textContent).toContain('Verified');
    expect(screen.getByTestId('forge-results-verify-run').textContent).toBe('Verify again');
  });

  it('says why the extension refused or failed', () => {
    render(<ForgeResultsVerify run={RUN} />);
    fireEvent.click(screen.getByTestId('forge-results-verify-run'));
    answer('forge:verify:request', 'forge:verify:error', {
      message: 'The org this run wrote to is no longer registered.',
      code: 'ORG_NOT_FOUND',
      retryable: false,
    });
    expect(screen.getByTestId('forge-results-verify-error').textContent).toContain(
      'The org this run wrote to is no longer registered.',
    );
  });
});

describe('ForgeVerificationView', () => {
  it('says per object the records there and those not, and each lookup that does not hold', () => {
    render(<ForgeVerificationView verification={PARTIAL} />);

    const contact = screen.getByTestId('forge-verification-Contact');
    expect(contact.firstChild?.textContent).toBe('Contact');
    expect(contact.textContent).toContain(
      'Contact: 1 of 2 there · 1 in the recycle bin · 2 lookups checked, 1 does not hold',
    );
    expect(
      within(contact)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      `${rid('003', 1)}: AccountId points at ${rid('001', 7)}; the run set it to ${rid('001', 1)}`,
    ]);
    expect(screen.getByTestId('forge-verification-Account').textContent).toBe(
      'Account: 1 of 1 there · 1 changed since the run · no lookup the run set to check',
    );
  });

  it('lists the records changed since the run, which a removal keeps', () => {
    render(<ForgeVerificationView verification={PARTIAL} />);
    const changed = screen.getByTestId('forge-verification-changed');
    expect(changed.textContent).toContain(
      '1 record changed since the run: a removal keeps it unless you also remove the records changed since the run.',
    );
    expect(changed.textContent).toContain(
      `Account ${rid('001', 1)}: modified 2026-10-01T08:30:00.000+0000`,
    );
  });

  it('tells a record out of sight from one deleted, and a lookup left empty from one moved', () => {
    render(
      <ForgeVerificationView
        verification={{
          ...PARTIAL,
          objects: [
            {
              ...PARTIAL.objects[0],
              deleted: 0,
              deletedIds: [],
              notVisible: 1,
              notVisibleIds: [rid('003', 2)],
              brokenLinks: [
                {
                  recordId: rid('003', 1),
                  field: 'AccountId',
                  expected: rid('001', 1),
                  found: null,
                },
              ],
              recycleBinUnread: 'INVALID_FIELD: No such column IsDeleted',
            },
          ],
        }}
      />,
    );
    const contact = screen.getByTestId('forge-verification-Contact');
    expect(contact.textContent).toContain(
      '1 neither there nor in the recycle bin: out of your sight, not taken for deleted',
    );
    expect(contact.textContent).not.toContain('in the recycle bin ·');
    expect(
      within(contact)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      `${rid('003', 1)}: AccountId is empty; the run set it to ${rid('001', 1)}`,
      'The recycle bin could not be read: INVALID_FIELD: No such column IsDeleted',
    ]);
  });

  it('says an unstable verification as one to run again, and the lookups it could not check', () => {
    render(
      <ForgeVerificationView
        verification={{
          ...PARTIAL,
          verdict: 'unstable',
          attempts: 3,
          linksUnchecked: 'The org this run read from is no longer registered.',
        }}
      />,
    );
    expect(screen.getByTestId('forge-verification-verdict').textContent).toBe(
      'Unstable: no two readings agreed, something is still writing to these records. Verify again once it is done.',
    );
    expect(screen.getByTestId('forge-verification').textContent).toContain('3 readings,');
    expect(screen.getByTestId('forge-verification-links-unchecked').textContent).toBe(
      'Lookups not checked: The org this run read from is no longer registered.',
    );
  });

  it('says why an object could not be read', () => {
    render(
      <ForgeVerificationView
        verification={{
          ...PARTIAL,
          objects: [
            {
              ...PARTIAL.objects[1],
              error: 'INVALID_TYPE: Invoice__c',
              changed: 0,
              changedRecords: [],
            },
          ],
        }}
      />,
    );
    expect(screen.getByTestId('forge-verification-Account').textContent).toBe(
      'Account: not read: INVALID_TYPE: Invoice__c',
    );
  });
});
