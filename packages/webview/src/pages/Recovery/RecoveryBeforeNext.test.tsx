import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import '../../i18n';
import type { RecoveryPreparation } from '@sandforge/shared';
import { RecoveryBeforeNext } from './RecoveryBeforeNext';

const ITEMS: RecoveryPreparation[] = [
  { id: 'beforeRefreshCheckpoint', status: 'done', reason: 'ready' },
  { id: 'jobsInventory', status: 'todo', reason: 'toDo' },
  { id: 'testersList', status: 'todo', reason: 'toDo' },
  { id: 'automation', status: 'todo', reason: 'toDo' },
];

describe('RecoveryBeforeNext', () => {
  it('lists what to keep before the next refresh, each kept or to do, with its button', () => {
    render(<RecoveryBeforeNext items={ITEMS} alias="UAT" onAct={vi.fn()} />);
    const section = screen.getByRole('region', { name: 'Before the next refresh' });
    const kept = within(section).getByTestId('recovery-before-beforeRefreshCheckpoint');
    expect(kept).toHaveTextContent('Done');
    expect(kept).toHaveTextContent('A checkpoint of UAT is kept for the next refresh.');
    expect(within(section).getByTestId('recovery-before-automation')).toHaveTextContent(
      'Run a pipeline after each refresh, from the Sandbox Refresh Post-Processing template.',
    );
    expect(
      within(section).getByRole('button', { name: 'Automate after each refresh…' }),
    ).toBeInTheDocument();
  });

  it('does each thing on its button, and holds the one being done', () => {
    const onAct = vi.fn();
    render(
      <RecoveryBeforeNext
        items={ITEMS}
        alias="UAT"
        onAct={onAct}
        busy={new Set(['jobsInventory'])}
      />,
    );
    fireEvent.click(screen.getByTestId('recovery-before-testersList-action'));
    expect(onAct).toHaveBeenCalledWith('testersList');
    expect(screen.getByTestId('recovery-before-jobsInventory-action')).toHaveAttribute(
      'aria-busy',
      'true',
    );
  });
});
