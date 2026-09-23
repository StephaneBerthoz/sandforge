import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import type { SubjectRequestLogEntry } from '@sandforge/shared';
import { SubjectRequestLog } from './SubjectRequestLog';

let logState: {
  data: { entries: SubjectRequestLogEntry[] } | null;
  loading: boolean;
  error: string | null;
  refetch: ReturnType<typeof vi.fn>;
};
const save = vi.fn();

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: () => logState,
}));

vi.mock('../../hooks/useFileSave', () => ({
  useFileSave: () => ({ save, saving: false }),
}));

const entry = (requestId: string, orgId = 'org-1'): SubjectRequestLogEntry => ({
  requestId,
  orgId,
  openedAt: '2026-09-23T10:00:00.000Z',
  events: [
    {
      kind: 'searched',
      at: '2026-09-23T10:00:00.000Z',
      searchedBy: ['email', 'phone'],
      objects: [
        { objectApiName: 'Contact', found: 2, truncated: false },
        { objectApiName: 'Lead', found: 0, truncated: false },
      ],
    },
    { kind: 'exported', at: '2026-09-23T10:05:00.000Z', records: 2 },
    {
      kind: 'erased',
      at: '2026-09-23T10:10:00.000Z',
      mode: 'delete',
      outcome: 'partial',
      operationId: 'op-1',
      objects: [{ objectApiName: 'Contact', done: 1, failed: 1 }],
    },
  ],
});

beforeEach(() => {
  save.mockClear();
  logState = {
    data: { entries: [entry('aaaaaaaa-0000-4000-8000-000000000000')] },
    loading: false,
    error: null,
    refetch: vi.fn(),
  };
});

describe('SubjectRequestLog', () => {
  it('tells each step of a request in counts, never who it was about', () => {
    render(<SubjectRequestLog orgId="org-1" version={0} />);

    const request = screen.getByTestId('dsr-log-aaaaaaaa');
    expect(request.textContent).toContain('Request aaaaaaaa');
    expect(request.textContent).toContain(
      'searched by email address, phone number in Contact, Lead — 2 records found',
    );
    expect(request.textContent).toContain('2 records exported');
    expect(request.textContent).toContain('deleted — partly done: 1 record deleted, 1 refused');
  });

  it('shows only the requests of the org on screen', () => {
    logState.data = {
      entries: [
        entry('aaaaaaaa-0000-4000-8000-000000000000'),
        entry('bbbbbbbb-0000-4000-8000-000000000000', 'org-2'),
      ],
    };

    render(<SubjectRequestLog orgId="org-1" version={0} />);

    expect(screen.queryByTestId('dsr-log-bbbbbbbb')).toBeNull();
  });

  it('asks for the log again when it has something new', () => {
    const { rerender } = render(<SubjectRequestLog orgId="org-1" version={0} />);
    expect(logState.refetch).not.toHaveBeenCalled();

    rerender(<SubjectRequestLog orgId="org-1" version={1} />);

    expect(logState.refetch).toHaveBeenCalledTimes(1);
  });

  it('saves the log as a file of counts', () => {
    render(<SubjectRequestLog orgId="org-1" version={0} />);

    fireEvent.click(screen.getByTestId('dsr-log-save-btn'));

    const [name, content, extensions] = save.mock.calls[0];
    expect(name).toMatch(/^sandforge-subject-request-log-\d{4}-\d{2}-\d{2}\.json$/);
    expect(JSON.parse(content)).toMatchObject({
      orgId: 'org-1',
      entries: [{ events: expect.any(Array) }],
    });
    expect(extensions).toEqual(['json']);
  });

  it('says when no request has been handled on the org', () => {
    logState.data = { entries: [] };

    render(<SubjectRequestLog orgId="org-1" version={0} />);

    expect(screen.getByTestId('dsr-log-empty')).toBeDefined();
    expect(screen.queryByTestId('dsr-log-save-btn')).toBeNull();
  });
});
