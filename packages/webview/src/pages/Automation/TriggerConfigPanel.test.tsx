import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { TriggerConfigPanel } from './TriggerConfigPanel';
import type { PipelineTrigger, PipelineTriggerStatus, TriggerType } from '@sandforge/shared';

const nightly: PipelineTrigger = {
  id: 't1',
  type: 'schedule',
  enabled: true,
  config: { cron: '0 2 * * *', timezone: 'UTC' },
};
const manual: PipelineTrigger = { id: 't2', type: 'manual', enabled: false, config: {} };
const onRefresh: PipelineTrigger = {
  id: 't3',
  type: 'sandbox_refresh',
  enabled: true,
  config: { orgId: 'org-uat' },
};
const triggers: PipelineTrigger[] = [nightly, manual];

const SANDBOXES = [
  { id: 'org-uat', alias: 'uat' },
  { id: 'org-dev', alias: 'dev' },
];

/** What the extension says of the saved schedule `t1`. */
function scheduleStatus(overrides: Partial<PipelineTriggerStatus> = {}): PipelineTriggerStatus {
  return {
    pipelineId: 'p1',
    triggerId: 't1',
    type: 'schedule',
    armed: true,
    timezone: 'UTC',
    nextRunAt: '2026-09-24T02:00:00.000Z',
    ...overrides,
  };
}

describe('TriggerConfigPanel', () => {
  it('marks the trigger types that start nothing as coming soon, and no other', () => {
    const types: TriggerType[] = [
      'manual',
      'schedule',
      'event',
      'webhook',
      'sandbox_refresh',
      'deployment_complete',
    ];
    render(
      <TriggerConfigPanel
        triggers={types.map((type) => ({ id: type, type, enabled: true, config: {} }))}
      />,
    );
    for (const type of ['manual', 'schedule', 'sandbox_refresh']) {
      expect(screen.queryByTestId(`trigger-coming-soon-${type}`)).toBeNull();
    }
    for (const type of ['event', 'webhook', 'deployment_complete']) {
      expect(screen.getByTestId(`trigger-coming-soon-${type}`).textContent).toBe('Coming soon');
    }
  });

  it('says on each trigger that starts nothing why it does not', () => {
    render(
      <TriggerConfigPanel
        triggers={[
          { id: 'e', type: 'event', enabled: true, config: {} },
          { id: 'w', type: 'webhook', enabled: true, config: {} },
          { id: 'd', type: 'deployment_complete', enabled: true, config: {} },
        ]}
      />,
    );
    expect(screen.getByTestId('trigger-soon-reason-e').textContent).toMatch(/no event source/);
    expect(screen.getByTestId('trigger-soon-reason-w').textContent).toMatch(/opens no port/);
    expect(screen.getByTestId('trigger-soon-reason-d').textContent).toMatch(
      /only when the Monitor asks/,
    );
  });

  it('says on the options of the add list which types start nothing, before one is added', () => {
    render(<TriggerConfigPanel />);
    const options = [
      ...screen.getByTestId('trigger-type-select').querySelectorAll('option'),
    ] as HTMLOptionElement[];
    const label = (value: string): string | null | undefined =>
      options.find((option) => option.value === value)?.textContent;
    expect(label('manual')).toBe('Manual');
    expect(label('schedule')).toBe('Schedule');
    expect(label('sandbox_refresh')).toBe('Sandbox Refresh');
    for (const value of ['event', 'webhook', 'deployment_complete']) {
      expect(label(value)).toContain('Coming soon');
    }
  });

  it('names the trigger type list for a screen reader', () => {
    render(<TriggerConfigPanel />);
    expect(screen.getByTestId('trigger-type-select').getAttribute('aria-label')).toBe(
      'Trigger type',
    );
  });

  it('says what starts a pipeline, and that a start missed while VS Code is closed is not made late', () => {
    render(<TriggerConfigPanel />);
    const note = screen.getByTestId('trigger-note').textContent ?? '';
    expect(note).toMatch(/Run Pipeline button, on a schedule, or on a sandbox refresh/);
    expect(note).toMatch(/while VS Code is open, one run at a time/);
    expect(note).toMatch(/written to History as missed, never made late/);
    expect(note).toMatch(/Event, webhook and deployment triggers start nothing yet/);
  });

  describe('a schedule', () => {
    it('shows the next run the extension planned, in the time zone it is read in', () => {
      render(
        <TriggerConfigPanel
          triggers={[{ ...nightly, config: { cron: '0 2 * * *', timezone: 'Asia/Tokyo' } }]}
          savedTriggers={[{ ...nightly, config: { cron: '0 2 * * *', timezone: 'Asia/Tokyo' } }]}
          statuses={[
            scheduleStatus({ timezone: 'Asia/Tokyo', nextRunAt: '2026-09-23T17:00:00.000Z' }),
          ]}
        />,
      );
      // 17:00 UTC is 02:00 the next day in Tokyo, which is what the cron says.
      expect(screen.getByTestId('trigger-next-run-t1').textContent).toMatch(
        /^Next run: .*2:00.*\(Asia\/Tokyo\)$/,
      );
    });

    it('says a time the extension sent that is not a date is unknown, whatever its zone', () => {
      // The zone's fallback formatted the value again and threw "Invalid time
      // value" a second time: the trigger panel did not render.
      render(
        <TriggerConfigPanel
          triggers={[nightly]}
          savedTriggers={[nightly]}
          statuses={[
            scheduleStatus({
              nextRunAt: 'not a date',
              lastFiredAt: 'neither',
              lastOutcome: 'started',
            }),
          ]}
        />,
      );
      expect(screen.getByTestId('trigger-next-run-t1').textContent).toBe('Next run: unknown (UTC)');
      expect(screen.getByTestId('trigger-last-t1').textContent).toBe('Last started: unknown');
    });

    it('says when it last started the pipeline, and when a start was missed', () => {
      const { rerender } = render(
        <TriggerConfigPanel
          triggers={[nightly]}
          savedTriggers={[nightly]}
          statuses={[
            scheduleStatus({ lastFiredAt: '2026-09-23T02:00:00.000Z', lastOutcome: 'started' }),
          ]}
        />,
      );
      expect(screen.getByTestId('trigger-last-t1').textContent).toMatch(/^Last started: /);
      rerender(
        <TriggerConfigPanel
          triggers={[nightly]}
          savedTriggers={[nightly]}
          statuses={[
            scheduleStatus({ lastFiredAt: '2026-09-23T02:00:00.000Z', lastOutcome: 'missed' }),
          ]}
        />,
      );
      expect(screen.getByTestId('trigger-last-t1').textContent).toMatch(
        /^Last start missed: .*History says why\.$/,
      );
    });

    it('says why it starts nothing, with what the extension found wrong', () => {
      render(
        <TriggerConfigPanel
          triggers={[nightly]}
          savedTriggers={[nightly]}
          statuses={[
            scheduleStatus({
              armed: false,
              nextRunAt: undefined,
              idle: 'badCron',
              detail: 'Constraint error, got value 61 expected range 0-59',
            }),
          ]}
        />,
      );
      const idle = screen.getByTestId('trigger-idle-t1').textContent ?? '';
      expect(idle).toContain('SandForge cannot read this cron expression.');
      expect(idle).toContain('got value 61');
      expect(screen.queryByTestId('trigger-next-run-t1')).toBeNull();
    });

    it('says an edit waits for the save, rather than show the status of what was saved', () => {
      render(
        <TriggerConfigPanel
          triggers={[{ ...nightly, config: { cron: '30 3 * * *', timezone: 'UTC' } }]}
          savedTriggers={[nightly]}
          statuses={[scheduleStatus()]}
        />,
      );
      expect(screen.getByTestId('trigger-unsaved-t1').textContent).toMatch(/^Not saved yet/);
      expect(screen.queryByTestId('trigger-next-run-t1')).toBeNull();
    });

    it('says a new trigger waits for the save', () => {
      render(<TriggerConfigPanel triggers={[nightly]} />);
      expect(screen.getByTestId('trigger-unsaved-t1')).toBeDefined();
    });

    it('says it starts nothing while a step of the pipeline cannot run', () => {
      render(
        <TriggerConfigPanel
          triggers={[nightly]}
          savedTriggers={[nightly]}
          statuses={[scheduleStatus()]}
          pipelineBlocked
        />,
      );
      expect(screen.getByTestId('trigger-idle-t1').textContent).toBe(
        'Starts nothing while a step of this pipeline cannot run.',
      );
      expect(screen.queryByTestId('trigger-next-run-t1')).toBeNull();
    });

    it('names the cron input after what it holds, not after its example', () => {
      render(<TriggerConfigPanel triggers={triggers} />);
      expect(screen.getByLabelText('Cron Expression')).toBe(screen.getByTestId('cron-input-t1'));
    });

    it('changes the expression and the time zone it is read in', () => {
      const onUpdate = vi.fn();
      render(<TriggerConfigPanel triggers={[nightly]} onUpdateTriggerConfig={onUpdate} />);
      fireEvent.change(screen.getByTestId('cron-input-t1'), { target: { value: '0 3 * * *' } });
      expect(onUpdate).toHaveBeenCalledWith('t1', { cron: '0 3 * * *' });
      fireEvent.change(screen.getByLabelText('Time zone'), { target: { value: 'Europe/Paris' } });
      expect(onUpdate).toHaveBeenCalledWith('t1', { timezone: 'Europe/Paris' });
    });

    it('shows the time zone of the extension for a schedule saved with none', () => {
      const legacy = { ...nightly, config: { cron: '0 2 * * *' } };
      render(
        <TriggerConfigPanel
          triggers={[legacy]}
          savedTriggers={[legacy]}
          statuses={[scheduleStatus({ timezone: 'America/Chicago' })]}
        />,
      );
      const select = screen.getByTestId('timezone-select-t1') as HTMLSelectElement;
      expect(select.value).toBe('');
      expect(select.selectedOptions[0].textContent).toBe('America/Chicago');
    });
  });

  describe('a sandbox refresh trigger', () => {
    it('offers the registered sandboxes, and names the one it waits for', () => {
      const onUpdate = vi.fn();
      render(
        <TriggerConfigPanel
          triggers={[onRefresh]}
          savedTriggers={[onRefresh]}
          sandboxes={SANDBOXES}
          statuses={[{ pipelineId: 'p1', triggerId: 't3', type: 'sandbox_refresh', armed: true }]}
          onUpdateTriggerConfig={onUpdate}
        />,
      );
      const select = screen.getByLabelText('Sandbox') as HTMLSelectElement;
      expect([...select.options].map((option) => option.textContent)).toEqual([
        'Choose a sandbox',
        'uat',
        'dev',
      ]);
      expect(select.value).toBe('org-uat');
      expect(screen.getByTestId('trigger-armed-t3').textContent).toBe(
        'Watching for a refresh of uat.',
      );
      fireEvent.change(select, { target: { value: 'org-dev' } });
      expect(onUpdate).toHaveBeenCalledWith('t3', { orgId: 'org-dev' });
    });

    it('keeps a sandbox SandForge no longer lists in view, and says why it starts nothing', () => {
      render(
        <TriggerConfigPanel
          triggers={[{ ...onRefresh, config: { orgId: 'org-gone' } }]}
          savedTriggers={[{ ...onRefresh, config: { orgId: 'org-gone' } }]}
          sandboxes={SANDBOXES}
          statuses={[
            {
              pipelineId: 'p1',
              triggerId: 't3',
              type: 'sandbox_refresh',
              armed: false,
              idle: 'unknownSandbox',
            },
          ]}
        />,
      );
      const select = screen.getByLabelText('Sandbox') as HTMLSelectElement;
      expect(select.value).toBe('org-gone');
      expect(select.selectedOptions[0].textContent).toBe('A sandbox SandForge no longer knows');
      expect(screen.getByTestId('trigger-idle-t3').textContent).toMatch(/Choose it again/);
    });

    it('says only a pipeline whose steps can all run is started', () => {
      render(<TriggerConfigPanel triggers={[onRefresh]} sandboxes={SANDBOXES} />);
      expect(screen.getByTestId('trigger-t3').textContent).toContain(
        'only a pipeline whose steps can all run',
      );
    });

    it('says when there is no sandbox to choose', () => {
      render(<TriggerConfigPanel triggers={[onRefresh]} />);
      expect(screen.getByTestId('trigger-no-sandbox-t3').textContent).toBe(
        'No sandbox is connected yet.',
      );
    });
  });

  it('should render the panel', () => {
    render(<TriggerConfigPanel />);
    expect(screen.getByTestId('trigger-config')).toBeDefined();
  });

  it('should show empty state when no triggers', () => {
    render(<TriggerConfigPanel />);
    expect(screen.getAllByText('Add Trigger').length).toBeGreaterThan(0);
  });

  it('should show trigger cards', () => {
    render(<TriggerConfigPanel triggers={triggers} />);
    expect(screen.getByTestId('trigger-t1')).toBeDefined();
    expect(screen.getByTestId('trigger-t2')).toBeDefined();
  });

  it('should show trigger type labels', () => {
    render(<TriggerConfigPanel triggers={triggers} />);
    expect(screen.getAllByText('Schedule').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Manual').length).toBeGreaterThan(0);
  });

  it('should show enabled/disabled badges', () => {
    render(<TriggerConfigPanel triggers={triggers} />);
    expect(screen.getByText('Active')).toBeDefined();
    expect(screen.getByText('Disabled')).toBeDefined();
  });

  it('should call onAddTrigger', () => {
    const onAdd = vi.fn();
    render(<TriggerConfigPanel onAddTrigger={onAdd} />);
    fireEvent.click(screen.getByTestId('add-trigger-btn'));
    expect(onAdd).toHaveBeenCalledWith('manual');
  });

  it('should call onRemoveTrigger', () => {
    const onRemove = vi.fn();
    render(<TriggerConfigPanel triggers={triggers} onRemoveTrigger={onRemove} />);
    fireEvent.click(screen.getByTestId('remove-trigger-t1'));
    expect(onRemove).toHaveBeenCalledWith('t1');
  });

  it('should call onToggleTrigger', () => {
    const onToggle = vi.fn();
    render(<TriggerConfigPanel triggers={triggers} onToggleTrigger={onToggle} />);
    fireEvent.click(screen.getByTestId('toggle-trigger-t1'));
    expect(onToggle).toHaveBeenCalledWith('t1', false);
  });
});
