import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { ReviewComplianceTab } from './ReviewComplianceTab';

vi.mock('../../stores/useForgeStore', () => {
  const store = Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        complianceReport: null,
        graph: null,
        config: null,
        setComplianceReport: vi.fn(),
      }),
    {
      getState: () => ({
        complianceReport: null,
        graph: null,
        config: null,
        setComplianceReport: vi.fn(),
      }),
    },
  );
  return { useForgeStore: store };
});

vi.mock('../../hooks/useMessageBus', () => ({
  useSendMessage: () => vi.fn(),
  useMessageListener: vi.fn(),
}));

/** Accessible name of a form control: its own aria-label, else its labels. */
function accessibleName(el: HTMLElement): string {
  const aria = el.getAttribute('aria-label');
  if (aria) return aria.trim();
  const labels = (el as HTMLSelectElement).labels;
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

describe('ReviewComplianceTab accessible names', () => {
  it('should name the framework select', () => {
    render(<ReviewComplianceTab />);
    expect(accessibleName(screen.getByTestId('framework-select'))).toContain('Framework');
  });

  it('should leave no orphan label', () => {
    render(<ReviewComplianceTab />);
    expect(orphanLabels(screen.getByTestId('review-compliance-tab'))).toEqual([]);
  });
});
