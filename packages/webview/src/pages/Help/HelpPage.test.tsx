import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import en from '../../i18n/locales/en.json';
import fr from '../../i18n/locales/fr.json';
import de from '../../i18n/locales/de.json';
import es from '../../i18n/locales/es.json';
import ja from '../../i18n/locales/ja.json';
import ptBR from '../../i18n/locales/pt-BR.json';
import { HelpPage } from './HelpPage';

/** The six bundles, for what the Help sections say rather than which exist. */
const LOCALES = { en, fr, de, es, ja, 'pt-BR': ptBR };

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { changeLanguage: vi.fn() },
  }),
}));

/*
 * The panel's webview state, which VS Code keeps while it sets the panel's
 * shell again: the Help panel is released while hidden and rebuilt as it is
 * shown, a new page that reads this state as it mounts.
 */
const webviewState = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock('../../hooks/useVSCodeApi', () => {
  const api = {
    postMessage: () => undefined,
    getState: () => webviewState.value,
    setState: (state: unknown) => {
      webviewState.value = state;
    },
  };
  return { useVSCodeApi: () => api, getVscodeApi: () => api };
});

const mockNavigate = vi.fn();
const mockSetShowWelcome = vi.fn();
interface MockAppState {
  navigate: typeof mockNavigate;
  setShowWelcome: typeof mockSetShowWelcome;
}
vi.mock('../../stores/useAppStore', () => {
  // Built on each access: the factory is hoisted above the mock declarations.
  const getState = (): MockAppState => ({
    navigate: mockNavigate,
    setShowWelcome: mockSetShowWelcome,
  });
  const useAppStore = (selector: (s: MockAppState) => unknown): unknown => selector(getState());
  useAppStore.getState = getState;
  return { useAppStore };
});

describe('HelpPage', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockSetShowWelcome.mockClear();
    webviewState.value = undefined;
  });

  it('opens on the section and the search it showed before its panel was hidden and rebuilt', () => {
    // Both were plain state: an article read beside the code closed, and the
    // search emptied, each time another tab of the editor group was looked at.
    const first = render(<HelpPage />);
    fireEvent.click(screen.getByTestId('help-section-faq').querySelector('button') as HTMLElement);
    fireEvent.change(screen.getByTestId('help-search'), { target: { value: 'help.faq' } });
    first.unmount();

    render(<HelpPage />);

    expect((screen.getByTestId('help-search') as HTMLInputElement).value).toBe('help.faq');
    expect(
      screen.getByTestId('help-section-faq').querySelector('button')?.getAttribute('aria-expanded'),
    ).toBe('true');
    expect(screen.queryByTestId('help-section-getting-started')).toBeNull();
  });

  it('should render the help page', () => {
    render(<HelpPage />);
    expect(screen.getByTestId('help-page')).toBeDefined();
  });

  it('should show the page title', () => {
    render(<HelpPage />);
    expect(screen.getByText('help.title')).toBeDefined();
  });

  it('should render all help sections', () => {
    render(<HelpPage />);
    expect(screen.getByTestId('help-section-getting-started')).toBeDefined();
    expect(screen.getByTestId('help-section-monitor')).toBeDefined();
    expect(screen.getByTestId('help-section-seed')).toBeDefined();
    expect(screen.getByTestId('help-section-sync')).toBeDefined();
    expect(screen.getByTestId('help-section-compare')).toBeDefined();
    expect(screen.getByTestId('help-section-dataops')).toBeDefined();
    expect(screen.getByTestId('help-section-automation')).toBeDefined();
    expect(screen.getByTestId('help-section-ai')).toBeDefined();
    expect(screen.getByTestId('help-section-shortcuts')).toBeDefined();
    expect(screen.getByTestId('help-section-faq')).toBeDefined();
  });

  it('covers Forge, Frozen Dataset and Grappe, which have their own pages', () => {
    render(<HelpPage />);
    for (const [id, title, content] of [
      ['forge', 'nav.forge', 'help.forgeContent'],
      ['frozen', 'nav.frozen', 'help.frozenContent'],
      ['grappe', 'nav.grappe', 'help.grappeContent'],
    ]) {
      expect(screen.getByTestId(`help-section-${id}`)).toBeDefined();
      fireEvent.click(screen.getByText(title));
      expect(screen.getByText(content)).toBeDefined();
    }
  });

  it('covers Autopilot, Migration and Reports, which have their own pages', () => {
    render(<HelpPage />);
    for (const [id, title, content] of [
      ['autopilot', 'nav.autopilot', 'help.autopilotContent'],
      ['migration', 'nav.migration', 'help.migrationContent'],
      ['reports', 'nav.reports', 'help.reportsContent'],
    ]) {
      expect(screen.getByTestId(`help-section-${id}`)).toBeDefined();
      fireEvent.click(screen.getByText(title));
      expect(screen.getByText(content)).toBeDefined();
    }
  });

  it('covers Checkpoints after Seed, opening on the sentence the side panel and Home say', () => {
    // The side bar lists it third, after Seed and Forge; Help had no word of it.
    render(<HelpPage />);
    const ids = screen
      .getAllByTestId(/^help-section-/)
      .map((section) => section.getAttribute('data-testid'));
    expect(ids.indexOf('help-section-checkpoint')).toBe(ids.indexOf('help-section-seed') + 1);
    fireEvent.click(screen.getByText('nav.checkpoint'));
    expect(screen.getByTestId('help-summary-checkpoint').textContent).toBe(
      'moduleSummary.checkpoint',
    );
    expect(screen.getByText('help.checkpointContent')).toBeDefined();
  });

  it('says what a checkpoint is in the words its page opens on, and what a rewind leaves, in every language', () => {
    for (const [lng, bundle] of Object.entries(LOCALES)) {
      const [concept, ...limits] = bundle.help.checkpointContent.split('\n');
      expect({ lng, opens: concept.startsWith(bundle.checkpoint.concept) }).toEqual({
        lng,
        opens: true,
      });
      // A DataOps backup, told apart from it.
      expect(concept, lng).toContain('DataOps');
      expect(limits, lng).toHaveLength(5);
      expect(
        limits.every((line) => line.startsWith('- ')),
        lng,
      ).toBe(true);
      expect(limits[1].toLowerCase(), lng).toContain(bundle.nav.checkpoint.toLowerCase());
      expect(limits[4], lng).toContain('30');
    }
    // What the guide says before anything else, in its order.
    const english = en.help.checkpointContent.split('\n').slice(1);
    for (const [line, says] of [
      [0, "It undoes everyone's work since the checkpoint"],
      [1, 'Never on a production org'],
      [2, 'Data only: fields, flows'],
      [3, 'Files are not covered'],
      [4, "holds the records' values unencrypted, personal data among them, on this machine"],
    ] as const) {
      expect(english[line]).toContain(says);
    }
  });

  it('puts Forge first among the modules, right after Getting Started', () => {
    // Every other first-run surface leads with Forge; Help listed it eighth.
    render(<HelpPage />);
    const ids = screen
      .getAllByTestId(/^help-section-/)
      .map((section) => section.getAttribute('data-testid'));
    expect(ids.slice(0, 2)).toEqual(['help-section-getting-started', 'help-section-forge']);
  });

  it('leads a new user from connecting to filling with Seed, cloning with Forge, then the Monitor, in every language', () => {
    // The order Home and the walkthrough use: an empty org is the problem, and
    // checking its health came third.
    for (const [lng, bundle] of Object.entries(LOCALES)) {
      const steps = bundle.help.gettingStartedContent.split('\n');
      expect(steps[1], lng).toMatch(/^2\. .*Seed/);
      expect(steps[2], lng).toMatch(/^3\. .*Forge/);
      expect(steps[3], lng).toContain(bundle.nav.monitor);
    }
  });

  it('opens Forge, Seed and Autopilot on the sentence the side panel, Home and their empty state say', () => {
    render(<HelpPage />);
    for (const [id, title, summary] of [
      ['forge', 'nav.forge', 'moduleSummary.forge'],
      ['seed', 'nav.seed', 'moduleSummary.seed'],
      ['autopilot', 'nav.autopilot', 'moduleSummary.autopilot'],
    ]) {
      fireEvent.click(screen.getByText(title));
      expect(screen.getByTestId(`help-summary-${id}`).textContent).toBe(summary);
    }
  });

  it('says one thing of each module in every language: Forge as the side panel says it, Autopilot as copying objects', () => {
    for (const [lng, bundle] of Object.entries(LOCALES)) {
      expect({ lng, forge: bundle.moduleSummary.forge }).toEqual({
        lng,
        forge: bundle.sidePanel.forgeDesc,
      });
    }
    // Autopilot was said to "populate your sandbox with realistic data", as Seed does.
    expect(en.moduleSummary.autopilot).toBe('Copy whole objects from one org to another');
    expect(en.moduleSummary.seed).toBe('Fill an org with realistic fake data');
  });

  it('lists Alt+N, which reaches the notification that stays up, and the arrows between tabs, in every language', () => {
    // A toast is drawn after the page, last in the Tab order: Alt+N is the way to it.
    for (const [lng, bundle] of Object.entries(LOCALES)) {
      const lines = bundle.help.shortcutsContent.split('\n');
      expect(
        lines.some((line) => line.startsWith('Alt+N — ')),
        lng,
      ).toBe(true);
      expect(lines, lng).toHaveLength(7);
    }
  });

  it('says Reports shows the audit trail and the lineage it renders, not that they are coming', () => {
    for (const [lng, bundle] of Object.entries(LOCALES)) {
      expect(bundle.help.reportsContent, lng).toContain(bundle.reports.audit);
      expect(bundle.help.reportsContent, lng).toContain(bundle.reports.lineage);
    }
    expect(en.help.reportsContent).not.toMatch(/coming soon/i);
  });

  it('says Production Guard refuses a delete on a production org, where it was said to ask', () => {
    expect(en.help.faqContent).not.toContain('All destructive operations require confirmation');
    expect(en.help.faqContent).toContain(
      'refuses a delete or a metadata deployment there outright',
    );
  });

  it('names no setting that turns the production question off, in six languages', () => {
    // It named sandforge.safety.requireProdConfirmation, which turned the
    // question off; every write to a production org now asks, whatever it says.
    for (const [lng, bundle] of Object.entries(LOCALES)) {
      expect(bundle.help.faqContent, lng).not.toContain('requireProdConfirmation');
    }
    expect(en.help.faqContent).toContain('no setting turns that question off');
  });

  it('should render the new troubleshooting and release notes sections', () => {
    render(<HelpPage />);
    expect(screen.getByTestId('help-section-troubleshooting')).toBeDefined();
    expect(screen.getByTestId('help-section-release-notes')).toBeDefined();
  });

  it('should have the getting-started section open by default', () => {
    render(<HelpPage />);
    expect(screen.getByText('help.gettingStartedContent')).toBeDefined();
  });

  it('should toggle a section open when clicked', () => {
    render(<HelpPage />);
    // Monitor section should be closed initially
    expect(screen.queryByText('help.monitorContent')).toBeNull();
    // Click the monitor section header
    fireEvent.click(screen.getByText('nav.monitor'));
    expect(screen.getByText('help.monitorContent')).toBeDefined();
  });

  it('should close the previously open section when another is opened', () => {
    render(<HelpPage />);
    // Getting-started is open by default
    expect(screen.getByText('help.gettingStartedContent')).toBeDefined();
    // Open monitor section
    fireEvent.click(screen.getByText('nav.monitor'));
    // Getting-started should close
    expect(screen.queryByText('help.gettingStartedContent')).toBeNull();
    expect(screen.getByText('help.monitorContent')).toBeDefined();
  });

  it('should close a section when clicked again', () => {
    render(<HelpPage />);
    expect(screen.getByText('help.gettingStartedContent')).toBeDefined();
    fireEvent.click(screen.getByText('help.gettingStarted'));
    expect(screen.queryByText('help.gettingStartedContent')).toBeNull();
  });

  it('should set aria-expanded correctly on section buttons', () => {
    render(<HelpPage />);
    const gettingStartedBtn = screen.getByText('help.gettingStarted').closest('button');
    expect(gettingStartedBtn?.getAttribute('aria-expanded')).toBe('true');

    const monitorBtn = screen.getByText('nav.monitor').closest('button');
    expect(monitorBtn?.getAttribute('aria-expanded')).toBe('false');
  });

  it('should navigate to settings when Open Settings is clicked', () => {
    render(<HelpPage />);
    fireEvent.click(screen.getByTestId('help-open-settings'));
    expect(mockNavigate).toHaveBeenCalledWith('settings');
  });

  it('should render the search input', () => {
    render(<HelpPage />);
    expect(screen.getByTestId('help-search')).toBeDefined();
  });

  it('should filter sections based on search query', () => {
    render(<HelpPage />);
    const searchInput = screen.getByTestId('help-search');
    fireEvent.change(searchInput, { target: { value: 'help.faq' } });
    // FAQ section should still be visible
    expect(screen.getByTestId('help-section-faq')).toBeDefined();
    // Since our t() mock returns the key itself, searching for "help.faq"
    // will match the FAQ title (help.faq) and content (help.faqContent)
  });

  it('should show no results message when search has no matches', () => {
    render(<HelpPage />);
    const searchInput = screen.getByTestId('help-search');
    fireEvent.change(searchInput, { target: { value: 'xyznonexistent123' } });
    expect(screen.getByTestId('help-no-results')).toBeDefined();
  });

  it('should show all sections when search is cleared', () => {
    render(<HelpPage />);
    const searchInput = screen.getByTestId('help-search');
    fireEvent.change(searchInput, { target: { value: 'xyznonexistent123' } });
    expect(screen.getByTestId('help-no-results')).toBeDefined();
    // Clear the search
    fireEvent.change(searchInput, { target: { value: '' } });
    expect(screen.queryByTestId('help-no-results')).toBeNull();
    expect(screen.getByTestId('help-section-getting-started')).toBeDefined();
  });

  it('should render Salesforce documentation links', () => {
    render(<HelpPage />);
    expect(screen.getByTestId('sf-link-help.sfDocs')).toBeDefined();
    expect(screen.getByTestId('sf-link-help.sfTrailhead')).toBeDefined();
    expect(screen.getByTestId('sf-link-help.sfStackExchange')).toBeDefined();
  });

  it('should have external links with correct attributes', () => {
    render(<HelpPage />);
    const sfDocsLink = screen.getByTestId('sf-link-help.sfDocs');
    expect(sfDocsLink.getAttribute('target')).toBe('_blank');
    expect(sfDocsLink.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('should render the Start Guided Tour button', () => {
    render(<HelpPage />);
    expect(screen.getByTestId('help-start-tour')).toBeDefined();
  });

  it('should raise the welcome overlay when Start Guided Tour is clicked', () => {
    // Routing to 'welcome' has no page behind it — PanelRouter would render
    // its unknown-module fallback instead of the wizard.
    render(<HelpPage />);
    fireEvent.click(screen.getByTestId('help-start-tour'));
    expect(mockSetShowWelcome).toHaveBeenCalledWith(true);
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
