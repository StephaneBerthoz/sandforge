import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { PipelineCanvas } from './PipelineCanvas';
import type { PipelineStep } from '@sandforge/shared';

const steps: PipelineStep[] = [
  { id: 's1', name: 'Backup Data', type: 'backup', config: {}, continueOnError: false },
  { id: 's2', name: 'Anonymize PII', type: 'anonymize', config: {}, continueOnError: true },
  { id: 's3', name: 'Sync to Dev', type: 'sync', config: {}, continueOnError: false, onSuccess: 's4' },
];

describe('PipelineCanvas', () => {
  it('should render the canvas', () => {
    render(<PipelineCanvas />);
    expect(screen.getByTestId('pipeline-canvas')).toBeDefined();
  });

  it('should show empty state when no steps', () => {
    render(<PipelineCanvas />);
    expect(screen.getByText('Drag a step to the canvas')).toBeDefined();
  });

  it('should show step nodes', () => {
    render(<PipelineCanvas steps={steps} />);
    expect(screen.getByTestId('canvas-step-s1')).toBeDefined();
    expect(screen.getByTestId('canvas-step-s2')).toBeDefined();
    expect(screen.getByTestId('canvas-step-s3')).toBeDefined();
  });

  it('should show step names', () => {
    render(<PipelineCanvas steps={steps} />);
    expect(screen.getByText('Backup Data')).toBeDefined();
    expect(screen.getByText('Anonymize PII')).toBeDefined();
  });

  it('should show step type badges', () => {
    render(<PipelineCanvas steps={steps} />);
    expect(screen.getAllByText('backup').length).toBeGreaterThan(0);
    expect(screen.getAllByText('anonymize').length).toBeGreaterThan(0);
  });

  it('should show continue on error badge', () => {
    render(<PipelineCanvas steps={steps} />);
    expect(screen.getByText('Continue on Error')).toBeDefined();
  });

  it('should call onSelectStep when clicked', () => {
    const onSelect = vi.fn();
    render(<PipelineCanvas steps={steps} onSelectStep={onSelect} />);
    fireEvent.click(screen.getByTestId('canvas-step-s1'));
    expect(onSelect).toHaveBeenCalledWith('s1');
  });

  it('should call onRemoveStep when remove clicked', () => {
    const onRemove = vi.fn();
    render(<PipelineCanvas steps={steps} onRemoveStep={onRemove} />);
    fireEvent.click(screen.getByTestId('remove-step-s1'));
    expect(onRemove).toHaveBeenCalledWith('s1');
  });

  it('should highlight selected step', () => {
    render(<PipelineCanvas steps={steps} selectedStepId="s2" />);
    const step = screen.getByTestId('canvas-step-s2');
    expect(step.className).toContain('focusBorder');
  });
});
