import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import '../../i18n';
import { CheckpointList } from './CheckpointList';
import { listEntry, polyfillDialog, readyCheckpoint } from './testing/checkpointFixtures';

/** The list rendered with spies for what it asks the page to do. */
function renderList(entries = [listEntry()], focusRewind?: string) {
  const onRename = vi.fn();
  const onKeep = vi.fn();
  const onDelete = vi.fn();
  const onRewind = vi.fn();
  render(
    <CheckpointList
      entries={entries}
      orgName="DEV-SB"
      onRename={onRename}
      onKeep={onKeep}
      onDelete={onDelete}
      onRewind={onRewind}
      {...(focusRewind ? { focusRewind } : {})}
    />,
  );
  return { onRename, onKeep, onDelete, onRewind };
}

const ID = 'ck-20261020-140512-a1b2';

describe('CheckpointList', () => {
  beforeEach(() => {
    polyfillDialog();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-22T14:06:03.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('says of each checkpoint when it was taken, the records it holds, its size and how long it is kept', () => {
    renderList();
    const row = screen.getByTestId(`checkpoint-row-${ID}`);
    expect(within(row).getByRole('heading', { name: 'Before UAT' })).toBeInTheDocument();
    expect(screen.getByTestId(`checkpoint-row-facts-${ID}`).textContent).toBe(
      'Taken 2 days ago · 2,412 records · 2.3 MB · Kept until Nov 19, 2026',
    );
  });

  it('says a checkpoint kept until it is deleted is kept so, with its box ticked', () => {
    renderList([listEntry(readyCheckpoint({ expiresAt: null }))]);
    expect(screen.getByTestId(`checkpoint-row-facts-${ID}`).textContent).toContain(
      'Kept until I delete it',
    );
    expect(screen.getByTestId(`checkpoint-keep-${ID}`)).toBeChecked();
  });

  it('keeps a checkpoint until it is deleted, or gives it back its expiry, from its box', () => {
    const { onKeep } = renderList();
    const box = screen.getByTestId(`checkpoint-keep-${ID}`);
    expect(box).not.toBeChecked();
    // Each control of a row says which checkpoint it acts on.
    expect(box).toHaveAccessibleDescription('Before UAT');
    fireEvent.click(box);
    expect(onKeep).toHaveBeenCalledWith(ID, true);
  });

  it('opens what a rewind to a checkpoint would do from its Rewind…, which names the checkpoint', () => {
    const { onRewind } = renderList();
    const rewind = screen.getByTestId(`checkpoint-rewind-${ID}`);
    expect(rewind.textContent).toBe('Rewind…');
    expect(rewind).toHaveAccessibleDescription('Before UAT');
    fireEvent.click(rewind);
    expect(onRewind).toHaveBeenCalledWith(ID);
  });

  it('hands the keyboard to the Rewind… of the checkpoint whose preview was just left', () => {
    const other = listEntry(readyCheckpoint({ checkpointId: 'ck-20261021-090000-0001' }));
    renderList([other, listEntry()], ID);
    expect(screen.getByTestId(`checkpoint-rewind-${ID}`)).toHaveFocus();
  });

  it.each([
    ['damaged', null, 'Its file cannot be read: this checkpoint can only be deleted.'],
    [
      'taking',
      readyCheckpoint({ status: 'taking' }),
      'Not finished: a take of it is under way, or one stopped before it ended. It can only be deleted.',
    ],
    [
      'failed',
      readyCheckpoint({ status: 'failed' }),
      'Its take failed: this checkpoint can only be deleted.',
    ],
    [
      'scratchExpired',
      readyCheckpoint(),
      'This scratch org has expired: its checkpoints can only be deleted.',
    ],
  ] as const)(
    'says why a %s checkpoint can only be deleted, and offers only Delete',
    (why, checkpoint, said) => {
      const entry = listEntry(checkpoint, { valid: false, why });
      renderList([entry]);
      expect(screen.getByTestId(`checkpoint-why-${entry.checkpointId}`).textContent).toBe(said);
      expect(screen.queryByTestId(`checkpoint-keep-${entry.checkpointId}`)).toBeNull();
      expect(screen.queryByTestId(`checkpoint-rename-${entry.checkpointId}`)).toBeNull();
      expect(screen.queryByTestId(`checkpoint-rewind-${entry.checkpointId}`)).toBeNull();
      expect(screen.getByTestId(`checkpoint-delete-${entry.checkpointId}`)).toBeInTheDocument();
    },
  );

  it('lists a checkpoint whose file cannot be read by its folder’s name', () => {
    renderList([
      listEntry(null, { checkpointId: 'ck-20261019-090000-dead', valid: false, why: 'damaged' }),
    ]);
    expect(screen.getByRole('heading', { name: 'ck-20261019-090000-dead' })).toBeInTheDocument();
  });

  it('says a checkpoint of a sandbox refreshed since is of the org before it, with the date when known', () => {
    renderList([
      listEntry(readyCheckpoint(), {
        valid: false,
        why: 'refreshed',
        refreshedAt: '2026-10-15T12:00:00.000Z',
      }),
    ]);
    expect(screen.getByTestId(`checkpoint-why-${ID}`).textContent).toBe(
      'DEV-SB was refreshed on Oct 15, 2026: this checkpoint is of the org before it, and can only be deleted.',
    );
  });

  it('renames a checkpoint to a name of one line, trimmed, and refuses a blank one', () => {
    const { onRename } = renderList();
    fireEvent.click(screen.getByTestId(`checkpoint-rename-${ID}`));
    const field = screen.getByTestId('checkpoint-rename-input');
    expect(field).toHaveValue('Before UAT');

    fireEvent.change(field, { target: { value: '   ' } });
    expect(screen.getByTestId('checkpoint-rename-save')).toBeDisabled();
    expect(
      screen.getByText('A name is one line of text, of 120 characters at most.'),
    ).toBeInTheDocument();

    fireEvent.change(field, { target: { value: '  Clean baseline ' } });
    fireEvent.click(screen.getByTestId('checkpoint-rename-save'));
    expect(onRename).toHaveBeenCalledWith(ID, 'Clean baseline');
  });

  it('deletes a checkpoint once its deletion is confirmed, saying the org is not touched', () => {
    const { onDelete } = renderList();
    fireEvent.click(screen.getByTestId(`checkpoint-delete-${ID}`));
    expect(screen.getByTestId('danger-title').textContent).toBe('Delete “Before UAT”?');
    expect(
      screen.getByText(
        'Deletes “Before UAT” from this machine: DEV-SB can no longer be rewound to it. The org is not touched.',
      ),
    ).toBeInTheDocument();
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('danger-confirm-btn'));
    expect(onDelete).toHaveBeenCalledWith(ID);
  });

  it('says a deletion takes the Undo of its rewind with it, while that rewind can be undone', () => {
    renderList([
      listEntry(
        readyCheckpoint({
          lastRewind: {
            rewindId: 'rw-20261022-100000-beef',
            endedAt: '2026-10-22T12:05:00.000Z',
            undoUntil: '2026-11-06T10:05:00.000Z',
          },
        }),
        { undo: { rewindId: 'rw-20261022-100000-beef', until: '2026-11-06T10:05:00.000Z' } },
      ),
    ]);
    fireEvent.click(screen.getByTestId(`checkpoint-delete-${ID}`));
    expect(
      screen.getByText(
        'Deletes “Before UAT” from this machine: DEV-SB can no longer be rewound to it, and the rewind of Oct 22, 2026 can no longer be undone. The org is not touched.',
      ),
    ).toBeInTheDocument();
  });

  it('leaves a checkpoint whose deletion is not confirmed', () => {
    const { onDelete } = renderList();
    fireEvent.click(screen.getByTestId(`checkpoint-delete-${ID}`));
    fireEvent.click(screen.getByTestId('danger-dismiss-btn'));
    expect(onDelete).not.toHaveBeenCalled();
  });
});
