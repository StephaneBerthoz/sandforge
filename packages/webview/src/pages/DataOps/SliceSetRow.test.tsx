import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import '../../i18n';
import type { BackupSetSummary, SliceSummary } from '@sandforge/shared';
import { SliceSetRow, SliceTable } from './SliceSetRow';

/** A slice as a listing gives it. */
function slice(index: number, over: Partial<SliceSummary> = {}): SliceSummary {
  return {
    index,
    objectApiName: 'Contact',
    snapshotId: `set-1-s000${index}`,
    rows: 1_000,
    masked: 1_000,
    refused: 0,
    deletedSince: 0,
    nothingToMask: 0,
    state: 'masked',
    ...over,
  };
}

/** A masking set of three slices, done. */
const set: BackupSetSummary = {
  setId: 'set-1',
  orgId: 'org-1',
  kind: 'masking',
  state: 'done',
  startedAt: '2026-11-14T08:00:00.000Z',
  lastActivityAt: '2026-11-14T09:00:00.000Z',
  size: 1_000,
  totalRecords: 2_500,
  templateId: 'tpl-1',
  slices: [slice(1), slice(2, { deletedSince: 1 }), slice(3, { rows: 500, masked: 500 })],
};

describe('SliceTable', () => {
  it('lists each slice of a masking with what it masked, refused and found deleted since', () => {
    render(
      <SliceTable
        slices={[slice(1), slice(2, { deletedSince: 1, late: true, sizeUsed: 500 })]}
        kind="masking"
        testId="t"
      />,
    );

    const cells = (index: number) =>
      [
        ...within(screen.getByTestId(`t-${index}`)).getAllByRole('rowheader'),
        ...within(screen.getByTestId(`t-${index}`)).getAllByRole('cell'),
      ].map((c) => c.textContent);
    expect(cells(1)).toEqual(['1', 'Contact', '1,000', '1,000', '0', '0', 'Masked']);
    expect(cells(2)).toEqual([
      '2 (late)',
      'Contact',
      '1,000 (read in slices of 500)',
      '1,000',
      '0',
      '1',
      'Masked',
    ]);
  });

  it('lists a backup’s slices by the rows they hold, which mask nothing', () => {
    render(<SliceTable slices={[slice(1, { state: 'snapshotted' })]} kind="backup" testId="t" />);

    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Slice',
      'Object',
      'Rows backed up',
      'State',
    ]);
    expect(within(screen.getByTestId('t-1')).getByText('Backed up')).toBeDefined();
  });
});

describe('SliceSetRow', () => {
  it('says what took the set, what it holds and where it stands', () => {
    render(<SliceSetRow set={set} />);

    expect(screen.getByTestId('restore-set-set-1-summary').textContent).toBe(
      '3 slices of up to 1,000 records, 2,500 records in all',
    );
    expect(screen.getByTestId('restore-set-set-1-state').textContent).toBe('Done');
  });

  it('shows its slices once opened, the button saying it controls them', () => {
    const onToggle = vi.fn();
    const { rerender } = render(<SliceSetRow set={set} onToggle={onToggle} />);
    const toggle = screen.getByTestId('restore-set-set-1-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    // Nothing to point at while the slices are hidden.
    expect(toggle.getAttribute('aria-controls')).toBeNull();
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledTimes(1);

    rerender(<SliceSetRow set={set} onToggle={onToggle} expanded />);
    const shown = screen.getByTestId('restore-set-set-1-toggle');
    expect(shown.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(shown.getAttribute('aria-controls') ?? '')).not.toBeNull();
    expect(screen.getByTestId('restore-set-set-1-slices-3')).toBeDefined();
  });

  it('restores the whole set, or one slice of it', () => {
    const onRestore = vi.fn();
    render(<SliceSetRow set={set} expanded onRestore={onRestore} />);

    fireEvent.click(screen.getByTestId('restore-set-set-1-all'));
    expect(onRestore).toHaveBeenLastCalledWith();
    fireEvent.click(screen.getByTestId('restore-set-set-1-slices-2-restore'));
    expect(onRestore).toHaveBeenLastCalledWith([2]);
  });

  it('restores nothing of a masking run still open, and says why to the keyboard', () => {
    const onRestore = vi.fn();
    render(<SliceSetRow set={{ ...set, state: 'open' }} expanded onRestore={onRestore} />);

    const all = screen.getByTestId('restore-set-set-1-all');
    expect(all.getAttribute('aria-disabled')).toBe('true');
    expect(document.getElementById(all.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      'Its masking run is still open: resume it to its end, or abandon it, on the Masking ' +
        'tab before restoring. Resumed, it would mask again what a restore puts back.',
    );
    fireEvent.click(all);
    fireEvent.click(screen.getByTestId('restore-set-set-1-slices-1-restore'));
    expect(onRestore).not.toHaveBeenCalled();
  });

  it('deletes the set only once its question is answered', () => {
    const onDelete = vi.fn();
    render(<SliceSetRow set={set} onDelete={onDelete} />);

    fireEvent.click(screen.getByTestId('restore-set-set-1-delete'));
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('restore-set-set-1-delete-confirm'));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(screen.getByTestId('restore-set-set-1-delete'));
  });

  it('names the filter a backup in slices held each object to', () => {
    render(
      <SliceSetRow set={{ ...set, kind: 'backup', wheres: { Contact: "LastName LIKE 'A%'" } }} />,
    );
    expect(screen.getByTestId('restore-set-set-1-filters').textContent).toBe(
      "Held to: Contact: LastName LIKE 'A%'",
    );
  });

  it('badges a backup in slices that stopped part way as partial, says no run takes it up, and restores it', () => {
    const onRestore = vi.fn();
    render(
      <SliceSetRow
        set={{
          ...set,
          kind: 'backup',
          state: 'partial',
          slices: [slice(1, { state: 'snapshotted', masked: 0 })],
        }}
        onRestore={onRestore}
      />,
    );

    expect(screen.getByTestId('restore-set-set-1-state').textContent).toBe('Partial');
    expect(screen.getByTestId('restore-set-set-1-partial').textContent).toBe(
      'Stopped before every record was backed up: no run takes it up. Its slices restore as they are; a new backup in slices takes every record again.',
    );
    expect(screen.queryByTestId('restore-set-set-1-held')).toBeNull();
    fireEvent.click(screen.getByTestId('restore-set-set-1-all'));
    expect(onRestore).toHaveBeenCalledTimes(1);
  });
});
