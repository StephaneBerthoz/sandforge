import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import en from '../../i18n/locales/en.json';
import { ConfigProfilePanel } from './ConfigProfilePanel';

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

  it('says whether each category is in the export, in words and by a tick', () => {
    // Border and colour alone told it, and the four chips looked alike.
    render(<ConfigProfilePanel />);
    const chip = screen.getByRole('button', { name: /^Sync mappings/ });
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    expect(chip.getAttribute('type')).toBe('button');
    expect(chip.querySelector('svg')).not.toBeNull();

    fireEvent.click(chip);

    expect(chip.getAttribute('aria-pressed')).toBe('false');
    expect(chip.querySelector('svg')).toBeNull();
  });

  it('names what it shares as the Forge page names it, under a heading that is no "profile"', () => {
    // "Profiles" reads as Salesforce Profiles to a consultant, and "Forge
    // Plans" named what the Forge page calls templates.
    render(<ConfigProfilePanel />);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(en.config.profiles.title);
    expect(screen.getByTestId('cat-toggle-forgePlans').textContent).toBe(
      en.config.categories.forgePlans,
    );
    expect(en.config.categories.forgePlans).toBe('Forge templates');
    expect(screen.getByTestId('config-profile-panel').textContent).not.toMatch(/profile/i);
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
