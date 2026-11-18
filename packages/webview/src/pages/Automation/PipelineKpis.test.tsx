import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import type {
  PipelineHistoryEntry,
  PipelineTrigger,
  PipelineTriggerStatus,
} from '@sandforge/shared';
import { PipelineKpis, lastRunOf, nextRunOf } from './PipelineKpis';
import { formatTriggerTime } from './TriggerConfigPanel';

const PIPELINE_ID = 'pipe-1';

function status(overrides: Partial<PipelineTriggerStatus>): PipelineTriggerStatus {
  return {
    pipelineId: PIPELINE_ID,
    triggerId: 'tr-1',
    type: 'schedule',
    armed: true,
    ...overrides,
  };
}

function entry(overrides: Partial<PipelineHistoryEntry>): PipelineHistoryEntry {
  return {
    runId: 'run-1',
    pipelineId: PIPELINE_ID,
    pipelineName: 'Nightly',
    status: 'completed',
    triggeredBy: 'manual',
    startTime: '2026-11-17T02:00:00.000Z',
    duration: 1000,
    stepCount: 2,
    errorCount: 0,
    ...overrides,
  };
}

const REFRESH_TRIGGER: PipelineTrigger = {
  id: 'tr-refresh',
  type: 'sandbox_refresh',
  enabled: true,
  config: { orgId: 'org-uat' },
};

const SANDBOXES = [{ id: 'org-uat', alias: 'uat' }];

describe('nextRunOf', () => {
  it('takes the soonest start a schedule of the pipeline plans', () => {
    expect(
      nextRunOf(
        [
          status({ triggerId: 'a', nextRunAt: '2026-11-20T02:00:00.000Z', timezone: 'UTC' }),
          status({ triggerId: 'b', nextRunAt: '2026-11-19T06:00:00.000Z', timezone: 'Asia/Tokyo' }),
        ],
        [],
        [],
      ),
    ).toEqual({ kind: 'time', at: '2026-11-19T06:00:00.000Z', timezone: 'Asia/Tokyo' });
  });

  it('reads no start from a trigger that starts nothing, or from a time that is no date', () => {
    expect(
      nextRunOf(
        [
          status({ armed: false, idle: 'disabled', nextRunAt: '2026-11-19T06:00:00.000Z' }),
          status({ triggerId: 'b', nextRunAt: 'tomorrow' }),
        ],
        [],
        [],
      ),
    ).toEqual({ kind: 'none' });
  });

  it('names the sandbox whose refresh starts it when no schedule plans a time', () => {
    expect(
      nextRunOf(
        [status({ triggerId: 'tr-refresh', type: 'sandbox_refresh' })],
        [REFRESH_TRIGGER],
        SANDBOXES,
      ),
    ).toEqual({ kind: 'refresh', sandbox: 'uat' });
  });
});

describe('lastRunOf', () => {
  it('takes the latest run of this pipeline, never another pipeline’s nor a start it missed', () => {
    const last = lastRunOf(
      [
        entry({ runId: 'old', startTime: '2026-11-10T02:00:00.000Z' }),
        entry({ runId: 'missed', status: 'missed', startTime: '2026-11-18T02:00:00.000Z' }),
        entry({ runId: 'other', pipelineId: 'pipe-2', startTime: '2026-11-18T03:00:00.000Z' }),
        entry({ runId: 'latest', status: 'failed', startTime: '2026-11-17T02:00:00.000Z' }),
      ],
      PIPELINE_ID,
    );
    expect(last?.runId).toBe('latest');
  });

  it('has none for a pipeline that never ran', () => {
    expect(lastRunOf([entry({ pipelineId: 'pipe-2' })], PIPELINE_ID)).toBeUndefined();
  });
});

describe('PipelineKpis', () => {
  it('shows the next start in its time zone, and how the last run ended and when', () => {
    render(
      <PipelineKpis
        pipelineId={PIPELINE_ID}
        statuses={[status({ nextRunAt: '2026-11-20T02:00:00.000Z', timezone: 'UTC' })]}
        triggers={[]}
        sandboxes={[]}
        history={[entry({ status: 'failed' })]}
      />,
    );

    const next = screen.getByTestId('automation-kpi-next-run');
    expect(next.querySelector('[data-testid="kpi-value"]')?.textContent).toBe(
      formatTriggerTime('2026-11-20T02:00:00.000Z', 'UTC'),
    );
    expect(next.querySelector('[data-testid="kpi-subtitle"]')?.textContent).toBe('UTC');
    const last = screen.getByTestId('automation-kpi-last-run');
    expect(last.querySelector('[data-testid="kpi-value"]')?.textContent).toBe('Failed');
    expect(last.querySelector('[data-testid="kpi-subtitle"]')?.textContent).toBe(
      formatTriggerTime('2026-11-17T02:00:00.000Z'),
    );
  });

  it('says the refresh of which sandbox starts it', () => {
    render(
      <PipelineKpis
        pipelineId={PIPELINE_ID}
        statuses={[status({ triggerId: 'tr-refresh', type: 'sandbox_refresh' })]}
        triggers={[REFRESH_TRIGGER]}
        sandboxes={SANDBOXES}
        history={[]}
      />,
    );

    const next = screen.getByTestId('automation-kpi-next-run');
    expect(next.querySelector('[data-testid="kpi-value"]')?.textContent).toBe('On a refresh');
    expect(next.querySelector('[data-testid="kpi-subtitle"]')?.textContent).toBe('uat');
  });

  it('says only Run Pipeline starts a pipeline no trigger starts, and that it never ran', () => {
    render(
      <PipelineKpis
        pipelineId={PIPELINE_ID}
        statuses={[]}
        triggers={[]}
        sandboxes={[]}
        history={[]}
      />,
    );

    const next = screen.getByTestId('automation-kpi-next-run');
    expect(next.querySelector('[data-testid="kpi-value"]')?.textContent).toBe('None');
    expect(next.querySelector('[data-testid="kpi-subtitle"]')?.textContent).toBe(
      'Only Run Pipeline starts it',
    );
    const last = screen.getByTestId('automation-kpi-last-run');
    expect(last.querySelector('[data-testid="kpi-value"]')?.textContent).toBe('None yet');
  });

  it('names the launcher that starts a pipeline whose schedule was handed over', () => {
    render(
      <PipelineKpis
        pipelineId={PIPELINE_ID}
        statuses={[]}
        triggers={[]}
        sandboxes={[]}
        history={[]}
        outsideRunner="cron"
      />,
    );

    const next = screen.getByTestId('automation-kpi-next-run');
    expect(next.querySelector('[data-testid="kpi-value"]')?.textContent).toBe('cron');
    expect(next.querySelector('[data-testid="kpi-subtitle"]')?.textContent).toBe(
      'Started outside VS Code',
    );
  });
});
