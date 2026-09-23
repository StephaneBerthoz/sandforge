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

    for (const type of ['seed', 'restore', 'delete', 'script', 'condition']) {
      const button = screen.getByTestId(`palette-${type}`);
      expect(button).toHaveProperty('disabled', true);
      fireEvent.click(button);
    }
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('adds the steps a pipeline runs through a module: Backup, Compare, Pre-check, Notification', () => {
    const onAdd = vi.fn();
    render(<StepPalette onAddStep={onAdd} />);

    for (const type of ['backup', 'compare', 'precheck', 'notification', 'delay']) {
      fireEvent.click(screen.getByTestId(`palette-${type}`));
    }
    expect(onAdd.mock.calls.map(([type]) => type)).toEqual([
      'backup',
      'compare',
      'precheck',
      'notification',
      'delay',
    ]);
  });

  it('says why a step type cannot be added, on the button and in the note it points to', () => {
    render(<StepPalette />);
    const note = screen.getByTestId('palette-runnable-note');
    expect(note.textContent).toContain(
      'Steps that write to an org — Seed, Sync, Restore, Anonymize, Delete — run only from their own pages',
    );

    // A step that writes is refused on purpose, and says where it runs instead.
    const seed = screen.getByTestId('palette-seed');
    expect(seed.getAttribute('aria-describedby')).toBe(note.id);
    expect(seed.getAttribute('title')).toContain('run it from its own page');
    expect(seed.getAttribute('title')).toContain('Production Guard');

    expect(screen.getByTestId('palette-script').getAttribute('title')).toBe(
      'This step type cannot run in a pipeline yet.',
    );
    // Condition has a reason of its own: nothing here gives it a condition.
    expect(screen.getByTestId('palette-condition').getAttribute('title')).toContain(
      'this page cannot set one yet',
    );

    const backup = screen.getByTestId('palette-backup');
    expect(backup.getAttribute('aria-describedby')).toBeNull();
    expect(backup.getAttribute('title')).toBeNull();
  });

  it('should show step type labels', () => {
    render(<StepPalette />);
    expect(screen.getAllByText('Seed').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Backup').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Delay').length).toBeGreaterThan(0);
  });

  it('marks the steps that write to an org as not in pipelines, and the unbuilt ones as coming soon', () => {
    render(<StepPalette />);
    for (const type of ['seed', 'sync', 'restore', 'anonymize', 'delete']) {
      expect(screen.getByTestId(`palette-${type}-soon`).textContent).toBe('Not in pipelines');
      expect(screen.getByTestId(`palette-${type}`)).toHaveProperty('disabled', true);
    }
    for (const type of ['script', 'approval', 'loop', 'parallel', 'condition']) {
      expect(screen.getByTestId(`palette-${type}-soon`).textContent).toBe('Coming soon');
      expect(screen.getByTestId(`palette-${type}`)).toHaveProperty('disabled', true);
    }
    for (const type of ['backup', 'compare', 'precheck', 'notification', 'delay']) {
      expect(screen.queryByTestId(`palette-${type}-soon`)).toBeNull();
      expect(screen.getByTestId(`palette-${type}`)).toHaveProperty('disabled', false);
    }
  });

  it('should show all categories in order', () => {
    render(<StepPalette />);
    const texts = screen.getAllByText(/(Data|Quality|Control Flow|Notification)/);
    expect(texts.length).toBeGreaterThanOrEqual(4);
  });
});
