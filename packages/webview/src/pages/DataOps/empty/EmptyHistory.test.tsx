import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import '../../../i18n';
import type { AuditLogEntry } from '@sandforge/shared';
import { EmptyHistory } from './EmptyHistory';
import { RUN_ID, auditEntry } from './testing/emptyAnswers';

const query = {
  data: null as { entries: AuditLogEntry[] } | null,
  loading: false,
  error: null as string | null,
  errorCode: null,
  refetch: vi.fn(),
};
const asked: Array<{ type: string; payload: unknown }> = [];

vi.mock('../../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: (type: string, payload: unknown) => {
    asked.push({ type, payload });
    return query;
  },
}));

beforeEach(() => {
  query.data = null;
  query.refetch = vi.fn();
  asked.length = 0;
});

describe('EmptyHistory', () => {
  it('reads the audit trail of the org, DataOps alone', () => {
    query.data = { entries: [] };
    render(
      <EmptyHistory orgId="org-1" orgName="dev" readAgainOn={null} onUndo={vi.fn()} busy={false} />,
    );
    expect(asked[0]).toEqual({
      type: 'reports:audit',
      payload: { module: 'dataops', orgId: 'org-1', limit: 2000 },
    });
    expect(screen.getByTestId('empty-history-none')).toHaveTextContent(
      'The audit trail of this machine holds no emptying of dev.',
    );
  });

  it('lists each emptying and undo, the latest first, Undo on the last emptying', () => {
    query.data = {
      entries: [
        auditEntry('run', '2026-11-12T10:00:00.000Z', {
          objects: [{ objectApiName: 'Account', created: 0, updated: 0, deleted: 5, failed: 2 }],
        }),
      ],
    };
    const onUndo = vi.fn();
    render(
      <EmptyHistory orgId="org-1" orgName="dev" readAgainOn={null} onUndo={onUndo} busy={false} />,
    );
    const entry = screen.getByTestId('empty-history-run-2026-11-12T10:00:00.000Z');
    expect(entry).toHaveTextContent('5 records deleted, 2 refused');
    expect(entry).toHaveTextContent(RUN_ID);
    fireEvent.click(screen.getByTestId('empty-history-undo'));
    expect(onUndo).toHaveBeenCalledWith(RUN_ID);
  });

  it('offers no Undo once the last emptying was undone', () => {
    query.data = {
      entries: [
        auditEntry('run', '2026-11-12T10:00:00.000Z'),
        auditEntry('undo', '2026-11-12T11:00:00.000Z'),
      ],
    };
    render(
      <EmptyHistory orgId="org-1" orgName="dev" readAgainOn={null} onUndo={vi.fn()} busy={false} />,
    );
    expect(screen.getByTestId('empty-history-list').querySelectorAll('li')).toHaveLength(2);
    expect(screen.queryByTestId('empty-history-undo')).toBeNull();
  });

  it('reads the trail again once an act of the page ended', () => {
    query.data = { entries: [] };
    const { rerender } = render(
      <EmptyHistory orgId="org-1" orgName="dev" readAgainOn={null} onUndo={vi.fn()} busy={false} />,
    );
    expect(query.refetch).not.toHaveBeenCalled();
    rerender(
      <EmptyHistory
        orgId="org-1"
        orgName="dev"
        readAgainOn={{ ended: true }}
        onUndo={vi.fn()}
        busy={false}
      />,
    );
    expect(query.refetch).toHaveBeenCalledTimes(1);
  });
});
