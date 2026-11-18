import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { dateTimeFormat } from '../../utils/formatters';
import { PipelineHistoryView } from './PipelineHistoryView';
import { useAppStore } from '../../stores/useAppStore';
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

  it('opens Reports on the Audit trail, where the writes of each step are', () => {
    const navigate = vi.fn();
    useAppStore.setState({ navigate });
    render(<PipelineHistoryView entries={entries} />);

    fireEvent.click(screen.getByTestId('pipeline-history-reports'));
    expect(navigate).toHaveBeenCalledWith('reports', { reportsTab: 'audit' });
  });

  it('says, with no run yet, what puts one here', () => {
    // Its description was "History", the name of the tab it sat in.
    render(<PipelineHistoryView />);
    const history = screen.getByTestId('pipeline-history');
    expect(history.textContent).toContain('No run yet');
    expect(history.textContent).toContain(
      'Runs appear here after Run Pipeline or a trigger starts the saved pipeline.',
    );
  });

  it('dates each run in the reader’s language and time zone, never as the stored ISO string', () => {
    render(<PipelineHistoryView entries={entries} />);
    const card = screen.getByTestId('history-run-2');
    expect(card.textContent).not.toContain('2026-02-19T10:00:00Z');
    expect(card.textContent).toContain(
      dateTimeFormat({ dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date('2026-02-19T10:00:00Z'),
      ),
    );
  });

  it('says a start time that is not a date is unknown, and still lists the run', () => {
    render(<PipelineHistoryView entries={[{ ...entries[0], startTime: 'not a date' }]} />);
    expect(screen.getByTestId('history-run-1').textContent).toContain('unknown');
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

  it('lists a stopped step as stopped, what the stop left in no red, and counts no error', () => {
    render(
      <PipelineHistoryView
        entries={[
          {
            ...entries[1],
            status: 'cancelled',
            errorCount: 0,
            steps: [
              {
                stepName: 'Pause',
                stepType: 'delay',
                status: 'stopped',
                duration: 300,
                error: 'Step "Pause" was stopped before it finished.',
              },
            ],
          },
        ]}
      />,
    );

    const step = screen.getByTestId('history-steps-run-2').querySelector('li');
    expect(step?.textContent).toBe('PauseStopped300msStep "Pause" was stopped before it finished.');
    expect(step?.innerHTML).not.toContain('status-error');
    expect(screen.queryByText(/error/i)).toBeNull();
  });

  it('says how each Approval step was answered: what, where and when, or that nobody did', () => {
    render(
      <PipelineHistoryView
        entries={[
          {
            ...entries[1],
            steps: [
              {
                stepName: 'Look first',
                stepType: 'approval',
                status: 'completed',
                approval: {
                  decision: 'approved',
                  via: 'notification',
                  at: '2026-10-13T08:00:20.000Z',
                  by: 'sha256:0123456789ab',
                },
              },
              {
                stepName: 'Again',
                stepType: 'approval',
                status: 'failed',
                approval: { decision: 'rejected', via: 'page', at: '2026-10-13T08:01:00.000Z' },
              },
              {
                stepName: 'Later',
                stepType: 'approval',
                status: 'failed',
                approval: { decision: 'timedOut', at: '2026-10-13T09:01:00.000Z' },
              },
            ],
          },
        ]}
      />,
    );

    expect(screen.getByTestId('history-approval-run-2-0').textContent).toMatch(
      /^Approved in the VS Code notification, .+/,
    );
    expect(screen.getByTestId('history-approval-run-2-1').textContent).toMatch(
      /^Rejected on the Automation page, .+/,
    );
    expect(screen.getByTestId('history-approval-run-2-2').textContent).toMatch(
      /^Not approved in time: nobody answered by .+/,
    );
  });

  it('says an Approval of a command-line run was answered at its terminal, or ahead with --approve', () => {
    // Every channel but the notification read "on the Automation page": a run
    // of `sandforge pipeline run`, answered in a terminal or by --approve,
    // named a page nobody had open.
    render(
      <PipelineHistoryView
        entries={[
          {
            ...entries[1],
            ranFrom: 'commandLine',
            steps: [
              {
                stepName: 'Go?',
                stepType: 'approval',
                status: 'completed',
                approval: { decision: 'approved', via: 'terminal', at: '2026-11-20T02:00:20.000Z' },
              },
              {
                stepName: 'Go again?',
                stepType: 'approval',
                status: 'completed',
                approval: {
                  decision: 'approved',
                  via: 'commandLine',
                  at: '2026-11-20T02:01:00.000Z',
                },
              },
              {
                stepName: 'Stop?',
                stepType: 'approval',
                status: 'failed',
                approval: { decision: 'rejected', via: 'terminal', at: '2026-11-20T02:02:00.000Z' },
              },
              {
                stepName: 'Stop again?',
                stepType: 'approval',
                status: 'failed',
                approval: {
                  decision: 'rejected',
                  via: 'commandLine',
                  at: '2026-11-20T02:03:00.000Z',
                },
              },
            ],
          },
        ]}
      />,
    );

    const lines = [0, 1, 2, 3].map(
      (index) => screen.getByTestId(`history-approval-run-2-${index}`).textContent ?? '',
    );
    expect(lines[0]).toMatch(/^Approved at the terminal of the run, .+/);
    expect(lines[1]).toMatch(/^Approved ahead, on the command line \(--approve\), .+/);
    expect(lines[2]).toMatch(/^Rejected at the terminal of the run, .+/);
    expect(lines[3]).toMatch(/^Rejected on the command line, .+/);
    for (const line of lines) expect(line).not.toContain('Automation page');
  });

  it('marks a run the command line made on this machine, and only those', () => {
    render(
      <PipelineHistoryView
        entries={[
          { ...entries[0], ranFrom: 'commandLine' },
          { ...entries[1], ranFrom: 'editor' },
        ]}
      />,
    );

    expect(screen.getByTestId('history-command-line-run-1').textContent).toBe('Command line');
    expect(screen.queryByTestId('history-command-line-run-2')).toBeNull();
  });

  it('says whose runs it lists of each pipeline a launcher starts: this machine’s, never a CI’s', () => {
    render(
      <PipelineHistoryView
        entries={entries}
        outside={[
          {
            pipelineId: 'pipe-1',
            name: 'Daily Backup',
            runsOutside: {
              since: '2026-11-20T08:00:00.000Z',
              runner: 'cron',
              file: 'daily-backup.sandforge-pipeline.json',
              digest: `sha256:${'a'.repeat(64)}`,
            },
          },
          {
            pipelineId: 'pipe-2',
            name: 'Weekly Sync',
            runsOutside: {
              since: '2026-11-20T08:00:00.000Z',
              runner: 'githubActions',
              file: 'weekly-sync.sandforge-pipeline.json',
              digest: `sha256:${'b'.repeat(64)}`,
            },
          },
        ]}
      />,
    );

    expect(screen.getByTestId('history-outside-pipe-1').textContent).toMatch(
      /^Daily Backup: started by cron \(bash launcher\) since .+\. Its runs on this machine show here, marked Command line\.$/,
    );
    expect(screen.getByTestId('history-outside-pipe-2').textContent).toMatch(
      /^Weekly Sync: started by GitHub Actions since .+\. Its runs there do not show here: see the workflow's runs on GitHub\.$/,
    );
  });

  it('says it with no run listed yet too', () => {
    render(
      <PipelineHistoryView
        outside={[
          {
            pipelineId: 'pipe-1',
            name: 'Daily Backup',
            runsOutside: {
              since: '2026-11-20T08:00:00.000Z',
              runner: 'taskScheduler',
              file: 'daily-backup.sandforge-pipeline.json',
              digest: `sha256:${'a'.repeat(64)}`,
            },
          },
        ]}
      />,
    );

    expect(screen.getByTestId('history-outside-pipe-1').textContent).toContain(
      'started by Task Scheduler (PowerShell launcher)',
    );
    expect(screen.getByTestId('pipeline-history').textContent).toContain('No run yet');
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

    it('sends a start missed while VS Code was closed to Export…, whose launcher runs the whole pipeline', () => {
      // It listed one command per step type — `npx sandforge monitor` for a
      // Pre-check, which has neither its threshold nor its exit code —, and
      // none for a Condition, an Approval or the values a step hands on: a
      // cron job of those lines ran no pipeline.
      render(
        <PipelineHistoryView
          entries={[
            missedEntry({ reason: 'closed', count: 1 }),
            { ...missedEntry({ reason: 'asleep', count: 1 }), runId: 'missed-2' },
          ]}
        />,
      );

      for (const runId of ['missed-1', 'missed-2']) {
        const line = screen.getByTestId(`history-missed-export-${runId}`).textContent ?? '';
        expect(line).toBe(
          'With VS Code closed, nothing here starts it: export it with Export…, beside Run ' +
            'Pipeline, and its launcher (cron, Task Scheduler or GitHub Actions) runs the whole ' +
            'pipeline with npx sandforge.',
        );
        expect(line).not.toContain('npx sandforge monitor');
      }
    });

    it('sends nowhere a start missed while a run was still going: VS Code was open', () => {
      render(
        <PipelineHistoryView
          entries={[
            missedEntry({ reason: 'busy', count: 1, busySince: '2026-09-23T01:00:00.000Z' }),
          ]}
        />,
      );

      expect(screen.queryByTestId('history-missed-export-missed-1')).toBeNull();
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

    it('says a schedule fell due and started nothing, naming the step that cannot run and why', () => {
      const detail =
        'Step "Archive old cases" is a "archive" step, a step type this release of SandForge ' +
        'does not have: the pipeline was saved by a later release, or written by hand. ' +
        'Remove the step, or update SandForge.';
      render(
        <PipelineHistoryView
          entries={[missedEntry({ reason: 'cannotRun', count: 1, detail }, 'schedule')]}
        />,
      );
      const card = screen.getByTestId('history-missed-1');
      expect(card.textContent).toContain('Missed');
      expect(card.textContent).toContain('Triggered By: Schedule');
      // Said as a refresh, it read as a sandbox refreshed at the time it fell due.
      const refused = screen.getByTestId('history-missed-missed-1').textContent ?? '';
      expect(refused).toMatch(
        /^Due at .+: not started, because a step of this pipeline cannot run\./,
      );
      expect(refused).not.toContain('refresh');
      expect(refused).toContain(detail);
    });

    it('counts the starts a schedule fell due for while its pipeline could not run, gathered in one entry', () => {
      render(
        <PipelineHistoryView
          entries={[
            missedEntry(
              {
                reason: 'cannotRun',
                count: 3,
                lastDueAt: '2026-09-23T04:00:00.000Z',
                detail: 'Pipeline step "Seed" (seed) cannot run in a pipeline.',
              },
              'schedule',
            ),
          ]}
        />,
      );
      expect(screen.getByTestId('history-missed-missed-1').textContent).toMatch(
        /^3 starts due from .+ to .+: none was started, because a step of this pipeline cannot run\./,
      );
    });
  });
});
