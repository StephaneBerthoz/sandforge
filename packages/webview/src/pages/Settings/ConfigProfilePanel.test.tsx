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

/** The `mutate` of each bridge mutation the panel builds, by message type. */
const mutations = vi.hoisted(() => new Map<string, ReturnType<typeof vi.fn>>());

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: (type: string) => {
    if (!mutations.has(type)) mutations.set(type, vi.fn());
    return {
      mutate: mutations.get(type),
      data: null,
      loading: false,
      error: null,
      reset: vi.fn(),
    };
  },
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

  it('offers no Settings category, which exported nothing', () => {
    render(<ConfigProfilePanel />);
    expect(screen.queryByTestId('cat-toggle-settings')).toBeNull();
  });

  it('exports every category it offers when none is deselected', () => {
    mutations.clear();
    render(<ConfigProfilePanel />);

    fireEvent.click(screen.getByTestId('export-btn'));

    expect(mutations.get('config:export')).toHaveBeenCalledWith({
      categories: ['syncMappings', 'forgePlans', 'pipelines', 'anonymizationTemplates'],
    });
  });

  it('toggles category selection', () => {
    render(<ConfigProfilePanel />);
    const btn = screen.getByTestId('cat-toggle-syncMappings');
    expect(btn.className).toContain('border-hue-blue/50');
    fireEvent.click(btn);
    // After clicking, the category should be deselected (it starts selected)
    expect(btn.className).not.toContain('border-hue-blue/50');
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
