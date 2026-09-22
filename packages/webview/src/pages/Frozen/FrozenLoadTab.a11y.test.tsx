import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { FrozenLoadTab } from './FrozenLoadTab';
import { useFrozenStore } from '../../stores/useFrozenStore';

vi.mock('../../stores/useOrgStore', () => ({
  useOrgStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      orgs: [{ id: 'org-1', alias: 'Dev', status: 'connected' }],
      selectedOrgId: 'org-1',
    }),
}));

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: () => ({
    mutate: vi.fn(),
    data: null,
    loading: false,
    error: null,
    reset: vi.fn(),
  }),
}));

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

describe('FrozenLoadTab accessible names', () => {
  beforeEach(() => {
    useFrozenStore.setState({ progress: [], loadReport: null, verdict: null, lastError: null });
  });

  it('should name the pilot and reload checkboxes', () => {
    render(<FrozenLoadTab onRefetchStatus={vi.fn()} />);
    expect(accessibleName(screen.getByTestId('frozen-load-pilot'))).not.toBe('');
    expect(accessibleName(screen.getByTestId('frozen-load-reload'))).not.toBe('');
  });

  it('should name the target org dropdown', () => {
    render(<FrozenLoadTab onRefetchStatus={vi.fn()} />);
    expect(screen.getByTestId('frozen-load-target').getAttribute('aria-label')).toBeTruthy();
  });

  it('should leave no orphan label', () => {
    render(<FrozenLoadTab onRefetchStatus={vi.fn()} />);
    expect(orphanLabels(screen.getByTestId('frozen-load-tab'))).toEqual([]);
  });
});

describe('FrozenLoadTab progress bar', () => {
  beforeEach(() => {
    useFrozenStore.setState({
      progress: [{ phase: 'guards', status: 'started', progress: 35, message: 'Loading Account' }],
      loadReport: null,
      verdict: null,
      lastError: null,
    } as unknown as Parameters<typeof useFrozenStore.setState>[0]);
  });

  it('names the load progress bar after its heading', () => {
    render(<FrozenLoadTab onRefetchStatus={vi.fn()} />);
    const bar = screen.getByRole('progressbar', { name: 'Progress' });
    expect(bar.getAttribute('aria-valuenow')).toBe('35');
  });

  it('keeps the Frozen cyan on the fill', () => {
    render(<FrozenLoadTab onRefetchStatus={vi.fn()} />);
    const bar = screen.getByRole('progressbar', { name: 'Progress' });
    expect((bar.firstChild as HTMLElement).className).toContain('bg-hue-cyan');
  });
});
