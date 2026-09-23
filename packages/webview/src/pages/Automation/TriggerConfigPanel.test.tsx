import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { TriggerConfigPanel } from './TriggerConfigPanel';
import type { PipelineTrigger, TriggerType } from '@sandforge/shared';

const triggers: PipelineTrigger[] = [
  { id: 't1', type: 'schedule', enabled: true, config: { cron: '0 0 * * *', timezone: 'UTC' } },
  { id: 't2', type: 'manual', enabled: false, config: {} },
];

describe('TriggerConfigPanel', () => {
  it('marks every trigger type but manual as coming soon', () => {
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
    // Nothing fires a pipeline on a schedule, an event, a webhook, a sandbox
    // refresh or a deployment: SandForge has no pipeline scheduler.
    expect(screen.queryByTestId('trigger-coming-soon-manual')).toBeNull();
    for (const type of types.filter((type) => type !== 'manual')) {
      expect(screen.getByTestId(`trigger-coming-soon-${type}`).textContent).toBe('Coming soon');
    }
  });

  it('says on every option of the add list which types do not fire', () => {
    render(<TriggerConfigPanel />);
    const options = [
      ...screen.getByTestId('trigger-type-select').querySelectorAll('option'),
    ] as HTMLOptionElement[];

    // The list is what a user reads BEFORE adding a trigger; the badge on the
    // card below only appears once the dead trigger has been added.
    expect(options.find((option) => option.value === 'manual')?.textContent).toBe('Manual');
    for (const option of options.filter((option) => option.value !== 'manual')) {
      expect(option.textContent).toContain('Coming soon');
    }
  });

  it('names the trigger type list for a screen reader', () => {
    render(<TriggerConfigPanel />);
    expect(screen.getByTestId('trigger-type-select').getAttribute('aria-label')).toBe(
      'Trigger type',
    );
  });

  it('says in the panel that only manual runs start a pipeline', () => {
    render(<TriggerConfigPanel />);
    expect(screen.getByTestId('trigger-manual-only-note').textContent).toMatch(/manual/i);
  });

  it('says on a sandbox refresh trigger why it starts nothing, though refreshes are noticed', () => {
    render(
      <TriggerConfigPanel
        triggers={[
          { id: 'refresh', type: 'sandbox_refresh', enabled: true, config: {} },
          { id: 'deploy', type: 'deployment_complete', enabled: true, config: {} },
        ]}
      />,
    );

    const reason = screen.getByTestId('trigger-refused-refresh').textContent ?? '';
    expect(reason).toMatch(/notices a sandbox refresh/);
    // What a refresh calls for writes to an org, and no pipeline step does.
    expect(reason).toMatch(/pipelines start by hand/);
    expect(reason).toMatch(/writes to an org, and no pipeline step does/);
    // The reason is the refresh trigger's own, not a note on every card.
    expect(screen.queryByTestId('trigger-refused-deploy')).toBeNull();
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

  it('should show cron input for schedule trigger', () => {
    render(<TriggerConfigPanel triggers={triggers} />);
    expect(screen.getByTestId('cron-input-t1')).toBeDefined();
  });

  it('names the cron input after what it holds, not after its example', () => {
    render(<TriggerConfigPanel triggers={triggers} />);
    expect(screen.getByLabelText('Cron Expression')).toBe(screen.getByTestId('cron-input-t1'));
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
