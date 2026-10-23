import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import '../../i18n';
import { fakeHost, previewDiff, readyCheckpoint, rewindResult } from './testing/checkpointFixtures';
import type { FakeHost } from './testing/checkpointFixtures';
import type { RunShown, RunState } from './RewindRun';

const host = vi.hoisted(() => ({ current: null as null | FakeHost }));

vi.mock('../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => host.current?.api,
  getVscodeApi: () => host.current?.api,
}));

import { RewindRun } from './RewindRun';

/** A run the page started under the request `req-rewind-1`, still waiting on its answer. */
const RUNNING: RunState = {
  loading: true,
  requestId: 'req-rewind-1',
  result: null,
  error: null,
  errorCode: null,
};

/** A rewind of the default preview, or the undo named. */
const REWIND: RunShown = { kind: 'rewind', diff: previewDiff() };
const UNDO: RunShown = { kind: 'undo', rewindId: 'rw-20261022-140100-c3d4' };

/** The run rendered with spies for what it asks its page. */
function renderRun(state: RunState = RUNNING, run: RunShown = REWIND) {
  const spies = {
    onUndo: vi.fn(),
    onRewindAgain: vi.fn(),
    onIgnored: vi.fn(),
    onDone: vi.fn(),
  };
  const view = render(
    <RewindRun
      orgName="DEV-SB"
      checkpoint={readyCheckpoint()}
      run={run}
      state={state}
      {...spies}
    />,
  );
  const rerender = (next: RunState): void =>
    view.rerender(
      <RewindRun
        orgName="DEV-SB"
        checkpoint={readyCheckpoint()}
        run={run}
        state={next}
        {...spies}
      />,
    );
  return { ...spies, rerender };
}

describe('RewindRun', () => {
  beforeEach(() => {
    host.current = fakeHost();
  });

  it('lists what the rewind does, in the order it does it, and takes the keyboard', () => {
    renderRun();
    const heading = screen.getByRole('heading', { level: 2 });
    expect(heading.textContent).toBe('Rewind of DEV-SB to “Before UAT”');
    expect(heading).toHaveFocus();
    const phases = screen.getByRole('list', { name: 'What the rewind does, in order' });
    expect(
      within(phases)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'Bring back 1 record deleted since',
      'Give 6 records their values back',
      'Delete 8 records added since, children first',
      'Check: read DEV-SB again',
    ]);
  });

  it('says what the extension is doing, under the rewind’s own request, and how far it is', () => {
    renderRun();
    expect(screen.getByTestId('checkpoint-run-step').textContent).toBe('Starting…');
    act(() =>
      host.current?.push('operation:progress', {
        operationId: 'req-other',
        percentage: 90,
        processedRecords: 9,
        totalRecords: 10,
        currentStep: 'Another run',
      }),
    );
    expect(screen.getByTestId('checkpoint-run-step').textContent).toBe('Starting…');
    act(() =>
      host.current?.push('operation:progress', {
        operationId: 'req-rewind-1',
        percentage: 40,
        processedRecords: 30,
        totalRecords: 57,
        currentStep: 'Giving back Account',
      }),
    );
    expect(screen.getByTestId('checkpoint-run-step').textContent).toBe(
      'Giving back Account — 30 / 57',
    );
    expect(screen.getByRole('progressbar', { name: 'Progress of the rewind' })).toHaveAttribute(
      'aria-valuetext',
      '30 / 57',
    );
  });

  it('stops the rewind before its next call to the org, as Live Operations’ Cancel does', () => {
    renderRun();
    fireEvent.click(screen.getByRole('button', { name: 'Stop the rewind' }));
    expect(host.current?.lastPayload('execution:abort')).toEqual({ operationId: 'req-rewind-1' });
    expect(screen.getByRole('button', { name: 'Stop the rewind' })).toBeDisabled();
    expect(screen.getByText('Stopping before its next call to DEV-SB…')).toBeInTheDocument();
  });

  it('runs an undo with its own words and Stop, and no phases a preview would have said', () => {
    renderRun(RUNNING, UNDO);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(
      'Undo of the last rewind of DEV-SB',
    );
    expect(screen.queryByTestId('checkpoint-run-phases')).toBeNull();
    expect(screen.getByRole('progressbar', { name: 'Progress of the undo' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Stop the undo' }));
    expect(host.current?.lastPayload('execution:abort')).toEqual({ operationId: 'req-rewind-1' });
  });

  it('says what the rewind did once it answers, and hands its Undo to the page with what Undo could not bring back', () => {
    const { rerender, onUndo } = renderRun();
    const result = rewindResult({
      undo: {
        until: '2026-11-06T14:02:00.000Z',
        cannot: [{ objectApiName: 'OpportunityLineItem', count: 3 }],
      },
    });
    rerender({ ...RUNNING, loading: false, result });
    expect(screen.queryByTestId('checkpoint-run-running')).toBeNull();
    expect(screen.getByTestId('checkpoint-result-headline').textContent).toContain(
      'DEV-SB is back at “Before UAT”.',
    );
    expect(screen.getByRole('heading', { level: 2 })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Undo this rewind' }));
    expect(onUndo).toHaveBeenCalledWith('rw-20261022-140100-c3d4', [
      { objectApiName: 'OpportunityLineItem', count: 3 },
    ]);
  });

  it('says a rewind stopped before it answered with what it did, where the org stands, with Rewind again', () => {
    const { onRewindAgain, onDone } = renderRun({
      ...RUNNING,
      loading: false,
      error: 'The rewind was stopped.',
      errorCode: 'CANCELLED',
    });
    expect(screen.getByTestId('checkpoint-run-stopped').textContent).toBe(
      'Stopped part way: DEV-SB is between “Before UAT” and now. Rewind again to finish: it takes up from what still differs.',
    );
    expect(screen.queryByTestId('checkpoint-run-error')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Rewind again' }));
    expect(onRewindAgain).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('says a rewind the extension refused, in its words', () => {
    renderRun({
      ...RUNNING,
      loading: false,
      error: 'A SandForge run is writing to DEV-SB: rewind once it has ended.',
      errorCode: 'RUN_WRITING',
    });
    expect(screen.getByTestId('checkpoint-run-error')).toHaveTextContent(
      'A SandForge run is writing to DEV-SB: rewind once it has ended.',
    );
  });

  it('asks again for an undo the extension refused, so its automation can be accepted', () => {
    const { onUndo } = renderRun(
      {
        ...RUNNING,
        loading: false,
        error: 'Undoing updates 3 Accounts: flow “Account touch” runs on update. Undo refused.',
        errorCode: 'AUTOMATION',
      },
      UNDO,
    );
    expect(screen.queryByRole('button', { name: 'Rewind again' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Undo this rewind' }));
    expect(onUndo).toHaveBeenCalledWith('rw-20261022-140100-c3d4', []);
  });

  it('says an undo stopped before it answered, and offers no Undo of its own', () => {
    renderRun(
      { ...RUNNING, loading: false, error: 'The undo was stopped.', errorCode: 'CANCELLED' },
      UNDO,
    );
    expect(screen.getByTestId('checkpoint-run-stopped').textContent).toBe(
      'Stopped part way: undo the rewind again from the list of checkpoints to finish; it takes up from where it stopped.',
    );
    expect(screen.queryByRole('button', { name: 'Undo this rewind' })).toBeNull();
  });
});
