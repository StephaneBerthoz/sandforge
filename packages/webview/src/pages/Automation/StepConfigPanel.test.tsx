import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { StepConfigPanel } from './StepConfigPanel';
import type { PipelineStep } from '@sandforge/shared';

const step: PipelineStep = {
  id: 'step-1',
  name: 'Seed Accounts',
  type: 'seed',
  config: { objectName: 'Account', recordCount: 100 },
  continueOnError: false,
  timeout: 300,
  retries: 2,
};

describe('StepConfigPanel', () => {
  it('should show empty state when no step', () => {
    render(<StepConfigPanel />);
    expect(screen.getByTestId('step-config-empty')).toBeDefined();
  });

  it('should render panel with step', () => {
    render(<StepConfigPanel step={step} />);
    expect(screen.getByTestId('step-config-panel')).toBeDefined();
  });

  it('should show step name input', () => {
    render(<StepConfigPanel step={step} onUpdate={vi.fn()} />);
    const input = screen.getByTestId('step-name-input') as HTMLInputElement;
    expect(input.value).toBe('Seed Accounts');
  });

  it('should call onUpdate when name changes', () => {
    const onUpdate = vi.fn();
    render(<StepConfigPanel step={step} onUpdate={onUpdate} />);
    fireEvent.change(screen.getByTestId('step-name-input'), { target: { value: 'New Name' } });
    expect(onUpdate).toHaveBeenCalledWith('step-1', { name: 'New Name' });
  });

  it('should show timeout input', () => {
    render(<StepConfigPanel step={step} onUpdate={vi.fn()} />);
    const input = screen.getByTestId('step-timeout-input') as HTMLInputElement;
    expect(input.value).toBe('300');
  });

  it('should show retries input', () => {
    render(<StepConfigPanel step={step} onUpdate={vi.fn()} />);
    const input = screen.getByTestId('step-retries-input') as HTMLInputElement;
    expect(input.value).toBe('2');
  });

  it('should show continue on error checkbox', () => {
    render(<StepConfigPanel step={step} onUpdate={vi.fn()} />);
    const checkbox = screen.getByTestId('step-continue-error') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
  });

  it('should call onUpdate when continueOnError toggled', () => {
    const onUpdate = vi.fn();
    render(<StepConfigPanel step={step} onUpdate={onUpdate} />);
    fireEvent.click(screen.getByTestId('step-continue-error'));
    expect(onUpdate).toHaveBeenCalledWith('step-1', { continueOnError: true });
  });

  it('should show type-specific config for seed step', () => {
    render(<StepConfigPanel step={step} onUpdate={vi.fn()} />);
    expect(screen.getByTestId('step-type-config')).toBeDefined();
    const objectInput = screen.getByTestId('config-objectName') as HTMLInputElement;
    expect(objectInput.value).toBe('Account');
  });

  it('should call onUpdate for config field changes', () => {
    const onUpdate = vi.fn();
    render(<StepConfigPanel step={step} onUpdate={onUpdate} />);
    fireEvent.change(screen.getByTestId('config-objectName'), { target: { value: 'Contact' } });
    expect(onUpdate).toHaveBeenCalledWith('step-1', {
      config: { objectName: 'Contact', recordCount: 100 },
    });
  });

  it('should show boolean config field as checkbox for delete step', () => {
    const deleteStep: PipelineStep = {
      id: 'step-d',
      name: 'Delete',
      type: 'delete',
      config: { hardDelete: true },
      continueOnError: false,
    };
    render(<StepConfigPanel step={deleteStep} onUpdate={vi.fn()} />);
    const checkbox = screen.getByTestId('config-hardDelete') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
  });

  it('should show step type badge', () => {
    render(<StepConfigPanel step={step} />);
    expect(screen.getByTestId('step-config-panel').textContent).toContain('seed');
  });
});
