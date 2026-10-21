import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import en from '../../i18n/locales/en.json';
import { DisconnectBackups } from './DisconnectBackups';

/** What `backup:list` answers, and how it was asked. */
const listed = vi.hoisted(() => ({
  data: null as { backups: Array<{ operationId: string }> } | null,
  asked: [] as unknown[],
}));

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: (type: string, payload: unknown) => {
    listed.asked.push({ type, payload });
    return { data: listed.data, loading: false, error: null, refetch: vi.fn() };
  },
}));

describe('DisconnectBackups', () => {
  beforeEach(() => {
    listed.data = null;
    listed.asked.length = 0;
  });

  it('asks whether the org’s backups go with it, off until ticked', () => {
    listed.data = { backups: [{ operationId: 'bk-1' }, { operationId: 'bk-2' }] };
    const onChange = vi.fn();
    render(<DisconnectBackups orgId="org-1" checked={false} onChange={onChange} />);

    expect(listed.asked).toContainEqual({ type: 'backup:list', payload: { orgId: 'org-1' } });
    const box = screen.getByRole('checkbox', {
      name: en.org.disconnectDeleteBackups_other.replace('{{count}}', '2'),
    }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('asks nothing of an org with no backup on this machine', () => {
    listed.data = { backups: [] };
    render(<DisconnectBackups orgId="org-1" checked={false} onChange={vi.fn()} />);

    expect(screen.queryByTestId('disconnect-delete-backups')).toBeNull();
  });
});
