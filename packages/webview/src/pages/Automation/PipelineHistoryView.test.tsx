import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { PipelineHistoryView } from './PipelineHistoryView';
import type { PipelineHistoryEntry } from '@sandforge/shared';

const entries: PipelineHistoryEntry[] = [
  {
    runId: 'run-1',
    pipelineId: 'pipe-1',
    pipelineName: 'Daily Backup',
    status: 'completed',
    triggeredBy: 'schedule',
    startTime: '2026-02-20T00:00:00Z',
    duration: 45000,
    stepCount: 3,
    errorCount: 0,
  },
  {
    runId: 'run-2',
    pipelineId: 'pipe-2',
    pipelineName: 'Weekly Sync',
    status: 'failed',
    triggeredBy: 'manual',
    startTime: '2026-02-19T10:00:00Z',
    duration: 120000,
    stepCount: 5,
    errorCount: 2,
  },
];

describe('PipelineHistoryView', () => {
  it('should render the history view', () => {
    render(<PipelineHistoryView />);
    expect(screen.getByTestId('pipeline-history')).toBeDefined();
  });

  it('should show empty state when no entries', () => {
    render(<PipelineHistoryView />);
    expect(screen.getByText('No execution history')).toBeDefined();
  });

  it('should show history entries', () => {
    render(<PipelineHistoryView entries={entries} />);
    expect(screen.getByTestId('history-run-1')).toBeDefined();
    expect(screen.getByTestId('history-run-2')).toBeDefined();
  });

  it('should show pipeline names', () => {
    render(<PipelineHistoryView entries={entries} />);
    expect(screen.getByText('Daily Backup')).toBeDefined();
    expect(screen.getByText('Weekly Sync')).toBeDefined();
  });

  it('should show status badges', () => {
    render(<PipelineHistoryView entries={entries} />);
    expect(screen.getByText('Completed')).toBeDefined();
    expect(screen.getByText('Failed')).toBeDefined();
  });

  it('should show duration', () => {
    render(<PipelineHistoryView entries={entries} />);
    expect(screen.getByText(/45s/)).toBeDefined();
    expect(screen.getByText(/2min/)).toBeDefined();
  });

  it('should show error count for failed runs', () => {
    render(<PipelineHistoryView entries={entries} />);
    expect(screen.getByText('2 errors')).toBeDefined();
  });

  it('should call onSelectRun when clicked', () => {
    const onSelect = vi.fn();
    render(<PipelineHistoryView entries={entries} onSelectRun={onSelect} />);
    const wrapper = screen.getByTestId('history-run-1');
    fireEvent.click(wrapper.querySelector('[role="button"]')!);
    expect(onSelect).toHaveBeenCalledWith('run-1');
  });

  it('should show triggered by info', () => {
    render(<PipelineHistoryView entries={entries} />);
    expect(screen.getAllByText(/Schedule/).length).toBeGreaterThan(0);
  });

  it('lists what each step of a run did, how long it took, or why it failed', () => {
    render(
      <PipelineHistoryView
        entries={[
          {
            ...entries[1],
            steps: [
              {
                stepName: 'Snapshot',
                stepType: 'backup',
                status: 'completed',
                duration: 2000,
                summary: 'Backed up 4 records of 1 object from uat.',
              },
              {
                stepName: 'Limits',
                stepType: 'precheck',
                status: 'failed',
                duration: 300,
                error: 'Pre-check "Limits" failed on uat: API usage at 91% (critical).',
              },
              { stepName: 'Tell me', stepType: 'notification', status: 'skipped' },
            ],
          },
        ]}
      />,
    );

    const steps = screen.getByTestId('history-steps-run-2');
    const items = [...steps.querySelectorAll('li')].map((li) => li.textContent);
    expect(items).toEqual([
      'SnapshotCompleted2sBacked up 4 records of 1 object from uat.',
      'LimitsFailed300msPre-check "Limits" failed on uat: API usage at 91% (critical).',
      'Tell meSkipped',
    ]);
  });

  it('lists no steps for a run written before steps were kept', () => {
    render(<PipelineHistoryView entries={entries} />);
    expect(screen.queryByTestId('history-steps-run-1')).toBeNull();
  });

  describe('a start a trigger missed', () => {
    /** An entry for a start that was not made. */
    function missedEntry(
      missed: NonNullable<PipelineHistoryEntry['missed']>,
      triggeredBy: PipelineHistoryEntry['triggeredBy'] = 'schedule',
    ): PipelineHistoryEntry {
      return {
        runId: 'missed-1',
        pipelineId: 'pipe-1',
        pipelineName: 'Nightly backup',
        status: 'missed',
        triggeredBy,
        startTime: '2026-09-23T02:00:00.000Z',
        duration: 0,
        stepCount: 0,
        errorCount: 0,
        missed,
      };
    }

    it('reads as missed, says VS Code was closed, and that nothing was made late', () => {
      render(<PipelineHistoryView entries={[missedEntry({ reason: 'closed', count: 1 })]} />);
      const card = screen.getByTestId('history-missed-1');
      expect(card.textContent).toContain('Missed');
      expect(card.textContent).toContain('Triggered By: Schedule');
      expect(screen.getByTestId('history-missed-missed-1').textContent).toMatch(
        /^Due at .+, while VS Code was closed: not started, and not made late\.$/,
      );
      // It ran nothing: no duration, no step count.
      expect(card.textContent).not.toContain('Duration');
      expect(card.textContent).not.toMatch(/\d+ Steps/);
    });

    it('counts the starts missed during a long absence, and says when there were more', () => {
      render(
        <PipelineHistoryView
          entries={[
            missedEntry({
              reason: 'closed',
              count: 51,
              atLeast: true,
              lastDueAt: '2026-09-23T02:50:00.000Z',
            }),
          ]}
        />,
      );
      expect(screen.getByTestId('history-missed-missed-1').textContent).toMatch(
        /^51\+ starts due from .+ to .+, while VS Code was closed: none was made late\.$/,
      );
    });

    it('says a time the extension sent that is not a date is unknown, rather than failing', () => {
      // Formatting it threw "Invalid time value", and the history did not render.
      render(
        <PipelineHistoryView
          entries={[
            {
              ...missedEntry({ reason: 'closed', count: 2, lastDueAt: 'neither' }),
              startTime: 'not a date',
            },
          ]}
        />,
      );
      expect(screen.getByTestId('history-missed-missed-1').textContent).toBe(
        '2 starts due from unknown to unknown, while VS Code was closed: none was made late.',
      );
    });

    it('tells a start the computer slept through from one VS Code was closed for', () => {
      render(<PipelineHistoryView entries={[missedEntry({ reason: 'asleep', count: 1 })]} />);
      expect(screen.getByTestId('history-missed-missed-1').textContent).toContain(
        'as when the computer sleeps',
      );
    });

    it('names the run that was still going', () => {
      render(
        <PipelineHistoryView
          entries={[
            missedEntry({ reason: 'busy', count: 1, busySince: '2026-09-23T01:55:00.000Z' }),
          ]}
        />,
      );
      expect(screen.getByTestId('history-missed-missed-1').textContent).toMatch(
        /^Due at .+, while the run started at .+ was still going: not started\. A pipeline never runs twice at once\.$/,
      );
    });

    it('speaks of the refresh, not of a due time, for a sandbox refresh trigger', () => {
      render(
        <PipelineHistoryView
          entries={[
            missedEntry(
              { reason: 'busy', count: 1, busySince: '2026-09-23T01:55:00.000Z' },
              'sandbox_refresh',
            ),
            {
              ...missedEntry(
                {
                  reason: 'cannotRun',
                  count: 1,
                  detail:
                    'Step "Mask" is a anonymize step, and this step type cannot run in a pipeline yet.',
                },
                'sandbox_refresh',
              ),
              runId: 'missed-2',
            },
          ]}
        />,
      );
      expect(screen.getByTestId('history-missed-missed-1').textContent).toMatch(
        /^The refresh noticed at .+ came while the run started at .+ was still going/,
      );
      const refused = screen.getByTestId('history-missed-missed-2').textContent ?? '';
      expect(refused).toMatch(
        /^The refresh noticed at .+ started nothing: a step of this pipeline cannot run\./,
      );
      expect(refused).toContain('this step type cannot run in a pipeline yet.');
    });
  });
});
