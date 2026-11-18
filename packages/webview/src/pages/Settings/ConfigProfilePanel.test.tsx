import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
    // Plans" named what the Forge page calls templates. The heading is the
    // Settings section's, Share setup, where the tab said Export / Import.
    render(<ConfigProfilePanel />);
    expect(en.config.profiles.title).toBe('Share setup');
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

  describe('importing a file', () => {
    beforeEach(() => mutations.clear());

    /** Pick `file` in the panel's file field. */
    const pick = (file: File): void => {
      fireEvent.change(screen.getByTestId('import-file-input'), { target: { files: [file] } });
    };

    it('reads an export from a file, as Forge reads a template, and checks it at once', async () => {
      // An export came in only pasted into a box, where Forge imports a file.
      render(<ConfigProfilePanel />);
      const button = screen.getByRole('button', { name: 'Import from file…' });
      const input = screen.getByTestId('import-file-input') as HTMLInputElement;
      expect(input.type).toBe('file');
      expect(input.accept).toBe('.json,application/json');
      const opened = vi.spyOn(input, 'click');
      fireEvent.click(button);
      expect(opened).toHaveBeenCalledOnce();

      const json = '{"version":1,"categories":{}}';
      pick(new File([json], 'team-setup.json', { type: 'application/json' }));

      await waitFor(() => expect(mutations.get('config:validate')).toHaveBeenCalledWith({ json }));
      expect((screen.getByTestId('import-textarea') as HTMLTextAreaElement).value).toBe(json);
      expect(screen.getByTestId('import-file-read').textContent).toBe(
        'Read from team-setup.json: check what it holds below, then Import.',
      );
      expect(mutations.get('config:import')).not.toHaveBeenCalled();

      fireEvent.click(screen.getByTestId('import-btn'));
      expect(mutations.get('config:import')).toHaveBeenCalledWith({ json, overwrite: true });
    });

    it('still takes an export pasted in, the file being one way of two', () => {
      render(<ConfigProfilePanel />);
      const pasted = screen.getByTestId('import-textarea') as HTMLTextAreaElement;
      expect(pasted.placeholder).toBe(en.config.profiles.importPlaceholder);
      expect(en.config.profiles.importPlaceholder).toMatch(/^Or paste/);
    });
  });
});
