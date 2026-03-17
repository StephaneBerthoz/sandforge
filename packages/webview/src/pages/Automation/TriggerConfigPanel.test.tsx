import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { TriggerConfigPanel } from './TriggerConfigPanel';
import type { PipelineTrigger } from '@sandforge/shared';

const triggers: PipelineTrigger[] = [
  { id: 't1', type: 'schedule', enabled: true, config: { cron: '0 0 * * *', timezone: 'UTC' } },
  { id: 't2', type: 'manual', enabled: false, config: {} },
];

describe('TriggerConfigPanel', () => {
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
