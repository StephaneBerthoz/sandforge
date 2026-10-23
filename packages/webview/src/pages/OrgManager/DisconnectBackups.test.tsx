import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import en from '../../i18n/locales/en.json';
import { DisconnectBackups, DisconnectCheckpoints } from './DisconnectBackups';

/** What `backup:list` and `checkpoint:list` answer, and how they were asked. */
const listed = vi.hoisted(() => ({
  data: null as { backups: Array<{ operationId: string }> } | null,
  checkpoints: null as { checkpoints: Array<{ checkpointId: string }> } | null,
  asked: [] as unknown[],
}));

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: (type: string, payload: unknown) => {
    listed.asked.push({ type, payload });
    const data = type === 'checkpoint:list' ? listed.checkpoints : listed.data;
    return { data, loading: false, error: null, refetch: vi.fn() };
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

describe('DisconnectCheckpoints', () => {
  beforeEach(() => {
    listed.checkpoints = null;
    listed.asked.length = 0;
  });

  it('asks whether the org’s checkpoints go with it, off until ticked, and names every one it lists', () => {
    listed.checkpoints = {
      checkpoints: [
        { checkpointId: 'ck-20261020-140512-a1b2' },
        { checkpointId: 'ck-20261019-090000-dead' },
      ],
    };
    const onChange = vi.fn();
    const { rerender } = render(
      <DisconnectCheckpoints orgId="org-1" checked={[]} onChange={onChange} />,
    );

    expect(listed.asked).toContainEqual({ type: 'checkpoint:list', payload: { orgId: 'org-1' } });
    const box = screen.getByRole('checkbox', {
      name: "Also delete this org's 2 checkpoints kept on this machine, which hold its records' values in clear, and the Undo of their rewinds",
    }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect(onChange).toHaveBeenLastCalledWith([
      'ck-20261020-140512-a1b2',
      'ck-20261019-090000-dead',
    ]);

    rerender(
      <DisconnectCheckpoints
        orgId="org-1"
        checked={['ck-20261020-140512-a1b2', 'ck-20261019-090000-dead']}
        onChange={onChange}
      />,
    );
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('asks nothing of an org with no checkpoint on this machine', () => {
    listed.checkpoints = { checkpoints: [] };
    render(<DisconnectCheckpoints orgId="org-1" checked={[]} onChange={vi.fn()} />);

    expect(screen.queryByTestId('disconnect-delete-checkpoints')).toBeNull();
  });
});
