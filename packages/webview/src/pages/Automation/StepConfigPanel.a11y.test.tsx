import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { StepConfigPanel } from './StepConfigPanel';
import type { PipelineStep } from '@sandforge/shared';

const seedStep: PipelineStep = {
  id: 'step-1',
  name: 'Seed Accounts',
  type: 'seed',
  config: { objectName: 'Account', recordCount: 100 },
  continueOnError: false,
  timeout: 300,
  retries: 2,
};

/** A backup step carries a boolean config field (includeAttachments). */
const backupStep: PipelineStep = {
  id: 'step-2',
  name: 'Nightly Backup',
  type: 'backup',
  config: { backupName: 'nightly', includeAttachments: true },
  continueOnError: false,
};

/** Accessible name of a form control: its own aria-label, else its labels. */
function accessibleName(el: HTMLElement): string {
  const aria = el.getAttribute('aria-label');
  if (aria) return aria.trim();
  const labels = (el as HTMLInputElement).labels;
  return Array.from(labels ?? [])
    .map((l) => l.textContent ?? '')
    .join(' ')
    .trim();
}

/** Labels that name nothing — the accessible name is lost for their control. */
function orphanLabels(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll('label'))
    .filter((l) => l.control === null)
    .map((l) => (l.textContent ?? '').trim());
}

describe('StepConfigPanel accessible names', () => {
  it('should name the common step controls', () => {
    render(<StepConfigPanel step={seedStep} onUpdate={vi.fn()} />);
    for (const testId of [
      'step-name-input',
      'step-timeout-input',
      'step-retries-input',
      'step-continue-error',
    ]) {
      expect(accessibleName(screen.getByTestId(testId)), testId).not.toBe('');
    }
  });

  it('should name the type-specific text and number fields', () => {
    render(<StepConfigPanel step={seedStep} onUpdate={vi.fn()} />);
    expect(accessibleName(screen.getByTestId('config-objectName'))).not.toBe('');
    expect(accessibleName(screen.getByTestId('config-recordCount'))).not.toBe('');
  });

  it('should name the type-specific boolean field exactly once', () => {
    render(<StepConfigPanel step={backupStep} onUpdate={vi.fn()} />);
    const checkbox = screen.getByTestId('config-includeAttachments') as HTMLInputElement;
    expect(accessibleName(checkbox)).not.toBe('');
    expect(checkbox.labels?.length).toBe(1);
  });

  it('should leave no orphan label for any step type', () => {
    const { unmount } = render(<StepConfigPanel step={seedStep} onUpdate={vi.fn()} />);
    expect(orphanLabels(screen.getByTestId('step-config-panel'))).toEqual([]);
    unmount();

    render(<StepConfigPanel step={backupStep} onUpdate={vi.fn()} />);
    expect(orphanLabels(screen.getByTestId('step-config-panel'))).toEqual([]);
  });
});
