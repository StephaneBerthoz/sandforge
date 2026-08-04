import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConfigProfilePanel } from './ConfigProfilePanel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, defaultValue: string) => defaultValue,
  }),
}));

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: () => ({
    data: { categories: [{ category: 'syncMappings', entryCount: 3 }] },
    loading: false,
    error: null,
    refetch: vi.fn(),
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

describe('ConfigProfilePanel', () => {
  it('renders the panel', () => {
    render(<ConfigProfilePanel />);
    expect(screen.getByTestId('config-profile-panel')).toBeTruthy();
  });

  it('renders export section', () => {
    render(<ConfigProfilePanel />);
    expect(screen.getByTestId('config-export-section')).toBeTruthy();
  });

  it('renders import section', () => {
    render(<ConfigProfilePanel />);
    expect(screen.getByTestId('config-import-section')).toBeTruthy();
  });

  it('renders category toggle buttons', () => {
    render(<ConfigProfilePanel />);
    expect(screen.getByTestId('cat-toggle-syncMappings')).toBeTruthy();
    expect(screen.getByTestId('cat-toggle-pipelines')).toBeTruthy();
  });

  it('toggles category selection', () => {
    render(<ConfigProfilePanel />);
    const btn = screen.getByTestId('cat-toggle-syncMappings');
    fireEvent.click(btn);
    // After clicking, the category should be deselected (it starts selected)
    expect(btn.className).not.toContain('border-blue-500/50');
  });

  it('renders export button', () => {
    render(<ConfigProfilePanel />);
    expect(screen.getByTestId('export-btn')).toBeTruthy();
  });

  it('renders import textarea', () => {
    render(<ConfigProfilePanel />);
    expect(screen.getByTestId('import-textarea')).toBeTruthy();
  });

  it('renders validate and import buttons', () => {
    render(<ConfigProfilePanel />);
    expect(screen.getByTestId('validate-btn')).toBeTruthy();
    expect(screen.getByTestId('import-btn')).toBeTruthy();
  });

  it('renders overwrite checkbox', () => {
    render(<ConfigProfilePanel />);
    expect(screen.getByTestId('overwrite-checkbox')).toBeTruthy();
  });
});
