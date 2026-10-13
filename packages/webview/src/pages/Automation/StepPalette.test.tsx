import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { PIPELINE_STEP_TYPES } from '@sandforge/shared';
import { StepPalette } from './StepPalette';
import { paletteBlocker } from './stepRunnability';

/** The step types the palette renders a button for, in the order it shows them. */
function offeredTypes(): string[] {
  return screen
    .getAllByRole('button')
    .map((button) => button.getAttribute('data-testid') ?? '')
    .filter((id) => id.startsWith('palette-'))
    .map((id) => id.slice('palette-'.length));
}

describe('StepPalette', () => {
  it('should render the palette', () => {
    render(<StepPalette />);
    expect(screen.getByTestId('step-palette')).toBeDefined();
  });

  it('offers only the step types a pipeline built here runs, grouped by category', () => {
    // It listed all fifteen, ten of them disabled under "Not in pipelines" or
    // "Coming soon": none of the ten could be added.
    render(<StepPalette />);
    expect(offeredTypes()).toEqual([
      'sync',
      'backup',
      'compare',
      'precheck',
      'condition',
      'delay',
      'approval',
      'notification',
    ]);
    expect(PIPELINE_STEP_TYPES.filter((type) => paletteBlocker(type) === undefined).sort()).toEqual(
      offeredTypes().sort(),
    );
    for (const button of screen.getAllByRole('button')) {
      expect(button).toHaveProperty('disabled', false);
    }
    expect(screen.queryByText(/Coming soon|Not in pipelines/)).toBeNull();
  });

  it('should show the categories it offers a step of', () => {
    render(<StepPalette />);
    expect(screen.getByText('Data')).toBeDefined();
    expect(screen.getByText('Quality')).toBeDefined();
    expect(screen.getByText('Control Flow')).toBeDefined();
    // The category, and the one step type under it.
    expect(screen.getAllByText('Notification').length).toBe(2);
  });

  it('adds each step it offers', () => {
    const onAdd = vi.fn();
    render(<StepPalette onAddStep={onAdd} />);

    const offered = [
      'sync',
      'backup',
      'compare',
      'precheck',
      'condition',
      'delay',
      'approval',
      'notification',
    ];
    for (const type of offered) {
      fireEvent.click(screen.getByTestId(`palette-${type}`));
    }
    expect(onAdd.mock.calls.map(([type]) => type)).toEqual(offered);
  });

  it('offers no step a pipeline refuses, and says where the steps that write run', () => {
    render(<StepPalette />);
    for (const type of ['seed', 'restore', 'anonymize', 'delete']) {
      expect(screen.queryByTestId(`palette-${type}`)).toBeNull();
    }
    // Gone for good: no palette entry, and no label to show one with.
    for (const type of ['script', 'loop', 'parallel']) {
      expect(screen.queryByTestId(`palette-${type}`)).toBeNull();
    }
    const note = screen.getByTestId('palette-runnable-note').textContent ?? '';
    expect(note).toContain(
      'Seed, Restore, Anonymize and Delete write to an org and run only from their own pages',
    );
    expect(note).toContain('needs an Approval step before it');
    expect(note).not.toMatch(/\byet\b/);
  });

  it('should show step type labels', () => {
    render(<StepPalette />);
    expect(screen.getAllByText('Backup').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Pre-Check').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Delay').length).toBeGreaterThan(0);
  });
});
