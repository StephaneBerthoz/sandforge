import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import '../../i18n';
import {
  diffObject,
  fakeHost,
  filesDiff,
  previewDiff,
  readyCheckpoint,
  rewindResult,
} from './testing/checkpointFixtures';
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
      'Undelete 1 record deleted since',
      'Restore the values of 6 records changed since',
      'Delete 8 records added since, children first',
      'Check: read DEV-SB again',
    ]);
  });

  it('lists the links between files and records it puts back as they were, once it gave values back and before it deletes', () => {
    renderRun(RUNNING, { kind: 'rewind', diff: filesDiff() });
    const phases = screen.getByRole('list', { name: 'What the rewind does, in order' });
    expect(
      within(phases)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'Undelete 1 record deleted since',
      'Restore the values of 1 record changed since',
      'Put 4 links between files and records back as they were',
      'Delete 2 records added since, children first',
      'Check: read DEV-SB again',
    ]);
  });

  it('lists the records it makes again with new Ids once it brought back what the bin holds, before it gives values back', () => {
    renderRun(RUNNING, {
      kind: 'rewind',
      diff: previewDiff({
        objects: [...previewDiff().objects, diffObject('Case', { toRecreate: 2 })],
      }),
    });
    const phases = screen.getByRole('list', { name: 'What the rewind does, in order' });
    expect(
      within(phases)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'Undelete 1 record deleted since',
      'Make again 2 records the recycle bin no longer holds, with new Ids',
      'Restore the values of 6 records changed since',
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

  it('says a rewind stopped before it answered as one stopped before it wrote anything, where the org stands, with Rewind again', () => {
    // The extension answers CANCELLED only for a rewind stopped before its
    // first write; one stopped part way answers with its result. The page
    // said "Stopped part way: … between … and now" of an org nothing was
    // written to.
    const { onRewindAgain, onDone } = renderRun({
      ...RUNNING,
      loading: false,
      error: 'The rewind was stopped before it wrote anything to the org.',
      errorCode: 'CANCELLED',
    });
    expect(screen.getByTestId('checkpoint-run-stopped').textContent).toBe(
      'Stopped before it wrote anything: DEV-SB is as it was before this rewind. Rewind again to rewind it to “Before UAT”.',
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

  it('hints under a refusal of the emails, in the interface’s words, the way past it, and offers the rewind again', () => {
    const refused: RunState = {
      ...RUNNING,
      loading: false,
      error:
        'DEV-SB delivers every email its automation sends. Nothing was written. Tick "Let DEV-SB send these emails" in the preview to rewind all the same.',
      errorCode: 'EMAILS_DELIVERED',
    };
    const { onRewindAgain } = renderRun(refused);
    expect(screen.getByTestId('error-hint').textContent).toContain(
      'Start it again and tick the box that lets the org send them',
    );
    expect(screen.getByTestId('checkpoint-run-error').textContent).not.toContain('--accept-emails');
    fireEvent.click(screen.getByTestId('checkpoint-run-rewind-again'));
    expect(onRewindAgain).toHaveBeenCalledOnce();
  });

  it('hints it of an undo too, whose confirmation is asked again', () => {
    const { onUndo } = renderRun(
      {
        ...RUNNING,
        loading: false,
        error:
          "DEV-SB delivers every email its automation sends. Nothing was written. Tick the box for these emails in the undo's confirmation to undo all the same.",
        errorCode: 'EMAILS_DELIVERED',
      },
      UNDO,
    );
    expect(screen.getByTestId('error-hint').textContent).toContain(
      'Start it again and tick the box that lets the org send them',
    );
    fireEvent.click(screen.getByTestId('checkpoint-run-undo-again'));
    expect(onUndo).toHaveBeenCalledWith('rw-20261022-140100-c3d4', []);
  });

  it('says nothing of the box beside a refusal past the day’s emails, which no box lifts', () => {
    renderRun({
      ...RUNNING,
      loading: false,
      error: 'The rewind makes DEV-SB send more emails than it has left today.',
      errorCode: 'EMAILS',
    });
    expect(screen.queryByTestId('error-hint')).toBeNull();
  });

  it('says an undo stopped before it answered as one stopped before it wrote anything, and offers no Undo of its own', () => {
    // The extension answers CANCELLED only for an undo stopped before its
    // first write: the page said it stopped part way.
    renderRun(
      {
        ...RUNNING,
        loading: false,
        error: 'The undo was stopped before it wrote anything to the org.',
        errorCode: 'CANCELLED',
      },
      UNDO,
    );
    expect(screen.getByTestId('checkpoint-run-stopped').textContent).toBe(
      'Stopped before it wrote anything: DEV-SB is as the rewind left it, and the rewind can still be undone.',
    );
    expect(screen.queryByRole('button', { name: 'Undo this rewind' })).toBeNull();
  });
});
