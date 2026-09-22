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

  it('should call onAddStep with correct type for control step', () => {
    const onAdd = vi.fn();
    render(<StepPalette onAddStep={onAdd} />);
    fireEvent.click(screen.getByTestId('palette-delay'));
    expect(onAdd).toHaveBeenCalledWith('delay');
  });

  it('adds no step of a type that cannot run: its button is disabled', () => {
    // The extension refuses a pipeline holding one before its first step, so
    // adding it would only build a pipeline that cannot run.
    const onAdd = vi.fn();
    render(<StepPalette onAddStep={onAdd} />);

    for (const type of ['seed', 'backup', 'delete', 'compare', 'condition', 'notification']) {
      const button = screen.getByTestId(`palette-${type}`);
      expect(button).toHaveProperty('disabled', true);
      fireEvent.click(button);
    }
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('says why a step type cannot be added, on the button and in the note it points to', () => {
    render(<StepPalette />);
    const note = screen.getByTestId('palette-runnable-note');
    expect(note.textContent).toBe(
      'Only Delay steps can run in a pipeline for now. The other step types cannot be added yet.',
    );

    const seed = screen.getByTestId('palette-seed');
    expect(seed.getAttribute('aria-describedby')).toBe(note.id);
    expect(seed.getAttribute('title')).toBe('This step type cannot run in a pipeline yet.');

    // Condition has a reason of its own: nothing here gives it a condition.
    expect(screen.getByTestId('palette-condition').getAttribute('title')).toContain(
      'nothing here sets its condition',
    );

    const delay = screen.getByTestId('palette-delay');
    expect(delay.getAttribute('aria-describedby')).toBeNull();
    expect(delay.getAttribute('title')).toBeNull();
  });

  it('should show step type labels', () => {
    render(<StepPalette />);
    expect(screen.getAllByText('Seed').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Backup').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Delay').length).toBeGreaterThan(0);
  });

  it('marks the fourteen step types that cannot run as coming soon, and leaves Delay enabled', () => {
    render(<StepPalette />);
    // The extension has no handler for thirteen of them, and refuses every
    // Condition step this page can build: nothing here gives it a condition.
    const cannotRun = [
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
      'condition',
    ];
    for (const type of cannotRun) {
      expect(screen.getByTestId(`palette-${type}-soon`).textContent).toBe('Coming soon');
      expect(screen.getByTestId(`palette-${type}`)).toHaveProperty('disabled', true);
    }
    expect(screen.queryByTestId('palette-delay-soon')).toBeNull();
    expect(screen.getByTestId('palette-delay')).toHaveProperty('disabled', false);
    expect(screen.getAllByText('Coming soon')).toHaveLength(cannotRun.length);
  });

  it('should show all categories in order', () => {
    render(<StepPalette />);
    const texts = screen.getAllByText(/(Data|Quality|Control Flow|Notification)/);
    expect(texts.length).toBeGreaterThanOrEqual(4);
  });
});
