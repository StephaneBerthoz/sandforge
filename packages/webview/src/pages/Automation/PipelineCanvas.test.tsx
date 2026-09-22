import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { PipelineCanvas } from './PipelineCanvas';
import type { PipelineStep } from '@sandforge/shared';

const steps: PipelineStep[] = [
  { id: 's1', name: 'Backup Data', type: 'backup', config: {}, continueOnError: false },
  { id: 's2', name: 'Anonymize PII', type: 'anonymize', config: {}, continueOnError: true },
  {
    id: 's3',
    name: 'Sync to Dev',
    type: 'sync',
    config: {},
    continueOnError: false,
    onSuccess: 's4',
  },
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
    expect(step.className).toContain('--sf-accent');
  });

  it('marks each step that cannot run where it sits, with the reason', () => {
    // A Marketplace template or an AI draft lands here with steps the palette
    // would not add; the reader sees which ones before pressing Run.
    render(
      <PipelineCanvas
        steps={[
          ...steps,
          { id: 'c1', name: 'Gate', type: 'condition', config: {}, continueOnError: false },
          { id: 'd1', name: 'Pause', type: 'delay', config: {}, continueOnError: false },
          { id: 'd2', name: 'Wait', type: 'delay', config: { seconds: 5 }, continueOnError: false },
        ]}
      />,
    );

    const backup = screen.getByTestId('canvas-blocked-s1');
    expect(backup.textContent).toBe('Cannot run yet');
    expect(backup.getAttribute('title')).toBe('This step type cannot run in a pipeline yet.');
    expect(screen.getByTestId('canvas-blocked-s2')).toBeDefined();
    expect(screen.getByTestId('canvas-blocked-s3')).toBeDefined();
    expect(screen.getByTestId('canvas-blocked-c1').getAttribute('title')).toContain(
      'nothing here sets its condition',
    );
    expect(screen.getByTestId('canvas-blocked-d1').getAttribute('title')).toBe(
      'Set how many seconds this Delay step waits (from 0 up to 24 days).',
    );
    // A Delay step with its seconds runs, and is not marked.
    expect(screen.queryByTestId('canvas-blocked-d2')).toBeNull();
  });
});
