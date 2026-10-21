import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import en from '../../i18n/locales/en.json';
import { BackupsBeforeErasure } from './BackupsBeforeErasure';

/** What `backup:list` answers, and how it was asked. */
const listed = vi.hoisted(() => ({
  data: null as { backups: Array<{ operationId: string }> } | null,
  asked: [] as unknown[],
}));
/** What `backup:delete` answers, and what it was sent. */
const deletion = vi.hoisted(() => ({
  mutate: vi.fn(),
  data: null as { orgId: string; deleted: string[] } | null,
}));

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: (type: string, payload: unknown) => {
    listed.asked.push({ type, payload });
    return { data: listed.data, loading: false, error: null, refetch: vi.fn() };
  },
}));
vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: () => ({
    mutate: deletion.mutate,
    data: deletion.data,
    loading: false,
    error: null,
    errorCode: null,
    reset: vi.fn(),
  }),
}));

describe('BackupsBeforeErasure', () => {
  beforeEach(() => {
    listed.data = null;
    listed.asked.length = 0;
    deletion.mutate.mockClear();
    deletion.data = null;
  });

  it('says the backups taken before the erasure bring the person back, and deletes them once asked', () => {
    listed.data = { backups: [{ operationId: 'bk-1' }, { operationId: 'bk-2' }] };
    render(<BackupsBeforeErasure orgId="org-1" />);

    expect(listed.asked).toContainEqual({ type: 'backup:list', payload: { orgId: 'org-1' } });
    expect(screen.getByTestId('dsr-backups-before').textContent).toContain(
      en.dataops.dsr.backupsBefore_other.replace('{{count}}', '2'),
    );
    fireEvent.click(screen.getByTestId('dsr-backups-delete'));
    expect(deletion.mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('dsr-backups-delete-confirm'));
    expect(deletion.mutate).toHaveBeenCalledWith({
      orgId: 'org-1',
      operationIds: ['bk-1', 'bk-2'],
    });
  });

  it('says nothing for an org with no backup on this machine', () => {
    listed.data = { backups: [] };
    const { container } = render(<BackupsBeforeErasure orgId="org-1" />);

    expect(container.textContent).toBe('');
  });

  it('says how many were deleted once the host has', () => {
    listed.data = { backups: [{ operationId: 'bk-1' }] };
    deletion.data = { orgId: 'org-1', deleted: ['bk-1'] };
    render(<BackupsBeforeErasure orgId="org-1" />);

    expect(screen.getByTestId('dsr-backups-deleted').textContent).toBe(
      en.dataops.backupsDeleted_one.replace('{{count}}', '1'),
    );
  });
});
