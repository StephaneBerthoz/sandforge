import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { StepPalette } from './StepPalette';

describe('StepPalette', () => {
  it('should render the palette', () => {
    render(<StepPalette />);
    expect(screen.getByTestId('step-palette')).toBeDefined();
  });

  it('should show all 15 step type buttons', () => {
    render(<StepPalette />);
    expect(screen.getByTestId('palette-seed')).toBeDefined();
    expect(screen.getByTestId('palette-sync')).toBeDefined();
    expect(screen.getByTestId('palette-backup')).toBeDefined();
    expect(screen.getByTestId('palette-condition')).toBeDefined();
    expect(screen.getByTestId('palette-notification')).toBeDefined();
  });

  it('should show category labels', () => {
    render(<StepPalette />);
    expect(screen.getByText('Data')).toBeDefined();
    expect(screen.getByText('Control Flow')).toBeDefined();
    expect(screen.getByText('Quality')).toBeDefined();
  });

  it('should call onAddStep when a step is clicked', () => {
    const onAdd = vi.fn();
    render(<StepPalette onAddStep={onAdd} />);
    fireEvent.click(screen.getByTestId('palette-seed'));
    expect(onAdd).toHaveBeenCalledWith('seed');
  });

  it('should call onAddStep with correct type for control step', () => {
    const onAdd = vi.fn();
    render(<StepPalette onAddStep={onAdd} />);
    fireEvent.click(screen.getByTestId('palette-delay'));
    expect(onAdd).toHaveBeenCalledWith('delay');
  });

  it('should show step type labels', () => {
    render(<StepPalette />);
    expect(screen.getAllByText('Seed').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Backup').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Delay').length).toBeGreaterThan(0);
  });

  it('marks the thirteen step types that run nothing as coming soon, and only those', () => {
    render(<StepPalette />);
    // The extension executes Delay and Condition; every other type goes to a
    // pass-through handler that reports success without touching an org.
    const inert = [
      'seed',
      'sync',
      'backup',
      'restore',
      'anonymize',
      'delete',
      'compare',
      'precheck',
      'script',
      'notification',
      'approval',
      'loop',
      'parallel',
    ];
    for (const type of inert) {
      expect(screen.getByTestId(`palette-${type}-soon`).textContent).toBe('Coming soon');
    }
    for (const type of ['delay', 'condition']) {
      expect(screen.queryByTestId(`palette-${type}-soon`)).toBeNull();
    }
    expect(screen.getAllByText('Coming soon')).toHaveLength(inert.length);
  });

  it('should show all categories in order', () => {
    render(<StepPalette />);
    const texts = screen.getAllByText(/(Data|Quality|Control Flow|Notification)/);
    expect(texts.length).toBeGreaterThanOrEqual(4);
  });
});
