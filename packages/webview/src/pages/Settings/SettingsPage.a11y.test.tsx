import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { SettingsPage } from './SettingsPage';
import { stubLocaleBridge } from '../../i18n/testing/mockLocaleBridge';

/* The i18n module posts `i18n:locale` through this api for lazy locales. */
const mockPostMessage = vi.fn();
vi.mock('../../hooks/useVSCodeApi', () => ({
  getVscodeApi: () => ({
    postMessage: mockPostMessage,
    getState: () => undefined,
    setState: () => undefined,
  }),
  useVSCodeApi: () => ({
    postMessage: mockPostMessage,
    getState: () => undefined,
    setState: () => undefined,
  }),
}));

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: () => ({ data: null, loading: false, error: null, refetch: vi.fn() }),
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
  const labels = (el as HTMLInputElement | HTMLSelectElement).labels;
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

describe('SettingsPage accessible names', () => {
  beforeEach(() => {
    stubLocaleBridge(mockPostMessage);
  });

  it('should name the language select', () => {
    render(<SettingsPage />);
    expect(accessibleName(screen.getByTestId('language-select'))).not.toBe('');
    expect(orphanLabels(screen.getByTestId('general-settings'))).toEqual([]);
  });

  it('should name the AI api key input', () => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByText('AI'));
    expect(accessibleName(screen.getByTestId('ai-api-key-input'))).not.toBe('');
    expect(orphanLabels(screen.getByTestId('ai-settings'))).toEqual([]);
  });
});
