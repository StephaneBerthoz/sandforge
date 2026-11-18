import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { RECOVERY_STEP_IDS } from '@sandforge/shared';
import en from '../../i18n/locales/en.json';
import fr from '../../i18n/locales/fr.json';
import de from '../../i18n/locales/de.json';
import es from '../../i18n/locales/es.json';
import ja from '../../i18n/locales/ja.json';
import ptBR from '../../i18n/locales/pt-BR.json';
import * as lucide from 'lucide-react';
import { CHANGELOG_URL as WHATS_NEW_CHANGELOG_URL } from '../Welcome/WhatsNewPage';
import { NAV_GROUPS, TOOL_ITEMS } from '../../navigation/navGroups';
import { CHORD_MAP } from '../../hooks/useGlobalShortcuts';
import { CHANGELOG_URL, DOCS_URL, HELP_SECTIONS, HelpPage, REPOSITORY_URL } from './HelpPage';

/** The six bundles, for what the Help sections say rather than which exist. */
const LOCALES = { en, fr, de, es, ja, 'pt-BR': ptBR };

/** The repository, whose docs the Help sections send a reader to. */
const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..');

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // The key itself, or an inline default; interpolation options aside.
    t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
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
const mockSetShowWhatsNew = vi.fn();
const mockClearNavigationIntent = vi.fn();
/** What the last `navigate` asked the page to open on, until it reads it. */
const intent = vi.hoisted(() => ({
  value: null as { route: string; helpSection?: string } | null,
}));
interface MockAppState {
  navigate: typeof mockNavigate;
  setShowWelcome: typeof mockSetShowWelcome;
  setShowWhatsNew: typeof mockSetShowWhatsNew;
  navigationIntent: typeof intent.value;
  clearNavigationIntent: typeof mockClearNavigationIntent;
}
vi.mock('../../stores/useAppStore', () => {
  // Built on each access: the factory is hoisted above the mock declarations.
  const getState = (): MockAppState => ({
    navigate: mockNavigate,
    setShowWelcome: mockSetShowWelcome,
    setShowWhatsNew: mockSetShowWhatsNew,
    navigationIntent: intent.value,
    clearNavigationIntent: mockClearNavigationIntent,
  });
  const useAppStore = (selector: (s: MockAppState) => unknown): unknown => selector(getState());
  useAppStore.getState = getState;
  return { useAppStore };
});

/**
 * The side panel's rows, each with the lucide component it draws, read from
 * the source of `NAV_GROUPS`, which it lists them from: the side panel is its
 * own bundle.
 */
function sidePanelItems(): Array<{ id: string; icon: string }> {
  const source = readFileSync(join(__dirname, '..', '..', 'navigation', 'navGroups.tsx'), 'utf-8');
  return [...source.matchAll(/id: '([\w-]+)',\s*labelKey: '[^']+',\s*icon: <(\w+)/g)].map(
    ([, id, icon]) => ({ id, icon }),
  );
}

/** A caption as a sentence of a Help line says it: lower case first, no full stop. */
const asSaid = (caption: string): string => caption.replace(/[.。]$/u, '').toLowerCase();

/** The ids of the sections the page shows, in its order. */
const shownSections = (): string[] =>
  screen
    .getAllByTestId(/^help-section-/)
    .map((section) => (section.getAttribute('data-testid') ?? '').replace('help-section-', ''));

/** Opens a section by its header, unless it is open already. */
function openSection(id: string): void {
  const header = screen.getByTestId(`help-section-${id}`).querySelector('button') as HTMLElement;
  if (header.getAttribute('aria-expanded') !== 'true') fireEvent.click(header);
}

describe('HelpPage', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockSetShowWelcome.mockClear();
    mockSetShowWhatsNew.mockClear();
    mockClearNavigationIntent.mockClear();
    intent.value = null;
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

  it('covers Forge and Frozen Dataset, which have their own pages', () => {
    render(<HelpPage />);
    for (const [id, title, content] of [
      ['forge', 'nav.forge', 'help.forgeContent'],
      ['frozen', 'nav.frozen', 'help.frozenContent'],
    ]) {
      expect(screen.getByTestId(`help-section-${id}`)).toBeDefined();
      fireEvent.click(screen.getByText(title));
      expect(screen.getByText(content)).toBeDefined();
    }
  });

  it('has no Grappe section, its page retired, and says its panel in the Seed and Sync sections, in every language', () => {
    // The section sent the reader to a page that no longer exists: Grappe is
    // the setting, and the panel it adds to the run screens of Seed and Sync.
    render(<HelpPage />);
    expect(screen.queryByTestId('help-section-grappe')).toBeNull();
    expect(HELP_SECTIONS.map((section) => section.id)).not.toContain('grappe');
    for (const [lng, bundle] of Object.entries(LOCALES)) {
      expect('grappeContent' in bundle.help, lng).toBe(false);
      for (const content of [bundle.help.seedContent, bundle.help.syncContent]) {
        const line = content.split('\n').find((said) => said.includes('sandforge.grappe.enabled'));
        expect(line, lng).toBeDefined();
        expect(line, lng).toContain('Grappe');
        expect(line, lng).toMatch(/10[,. \u00a0\u202f]000/u);
      }
    }
    expect(en.help.seedContent).toContain('Grappe makes no run faster');
    expect(en.help.syncContent).toContain('Grappe makes no run faster');
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

  it('covers Checkpoints under Protect and restore, opening on the sentence the side panel and Home say', () => {
    // Help had no word of it.
    render(<HelpPage />);
    expect(
      within(screen.getByTestId('help-group-protect')).getByTestId('help-section-checkpoint'),
    ).toBeDefined();
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
      expect(limits, lng).toHaveLength(6);
      expect(
        limits.every((line) => line.startsWith('- ')),
        lng,
      ).toBe(true);
      expect(limits[1].toLowerCase(), lng).toContain(bundle.nav.checkpoint.toLowerCase());
      expect(limits[4], lng).toContain('30');
      // The replay into another org, by the name its row gives it.
      expect(limits[5], lng).toContain(bundle.checkpoint.replay.open);
    }
    // What the guide says before anything else, in its order.
    const english = en.help.checkpointContent.split('\n').slice(1);
    for (const [line, says] of [
      [0, "It undoes everyone's work since the checkpoint"],
      [1, 'Never on a production org'],
      [2, 'Data only: fields, flows'],
      [3, 'Files are not covered'],
      [4, "holds the records' values unencrypted, personal data among them, on this machine"],
      [5, 'never into a production org'],
    ] as const) {
      expect(english[line]).toContain(says);
    }
  });

  it('names what a rewind does in the words of its preview, Restore values and Undelete, in every language', () => {
    // It said "gives back … brings back", the preview's old Give back and
    // Bring back, two near-synonyms side by side.
    for (const [lng, bundle] of Object.entries(LOCALES)) {
      const [concept] = bundle.help.checkpointContent.split('\n');
      const { delete: remove, giveBack, bringBack } = bundle.checkpoint.preview.table;
      for (const word of [remove, giveBack, bringBack]) {
        expect({ lng, word, said: concept.includes(word) }).toEqual({ lng, word, said: true });
      }
    }
    expect(en.help.checkpointContent).not.toMatch(/Give back|Bring back/);
  });

  it('groups the modules under the launcher’s five headings, in its order, after four sections that lead and before a Reference group', () => {
    // Twenty sections in one flat list, in an order of their own: a reader
    // looking for what masks a refreshed sandbox's data read every title.
    render(<HelpPage />);
    const lead = ['getting-started', 'recovery', 'orgs', 'safety'];
    const reference = ['shortcuts', 'faq', 'troubleshooting', 'release-notes'];
    expect(shownSections()).toEqual([
      ...lead,
      ...NAV_GROUPS.flatMap((group) =>
        group.items.map((item) => item.id).filter((id) => !lead.includes(id)),
      ),
      ...reference,
    ]);
    // Each group under the launcher's own heading, its sections inside it.
    const groups = screen.getAllByTestId(/^help-group-/);
    expect(groups.map((group) => group.getAttribute('data-testid'))).toEqual([
      'help-group-lead',
      ...NAV_GROUPS.map((group) => `help-group-${group.id}`),
      'help-group-reference',
    ]);
    expect(within(groups[0]).queryByRole('heading')).toBeNull();
    for (const group of NAV_GROUPS) {
      const drawn = screen.getByTestId(`help-group-${group.id}`);
      expect(within(drawn).getByRole('heading', { level: 2 }).textContent).toBe(group.labelKey);
      const inside = within(drawn)
        .getAllByTestId(/^help-section-/)
        .map((section) => section.getAttribute('data-testid'));
      expect(inside).toEqual(
        group.items
          .filter((item) => !lead.includes(item.id))
          .map((item) => `help-section-${item.id}`),
      );
    }
    expect(
      within(screen.getByTestId('help-group-reference')).getByRole('heading', { level: 2 })
        .textContent,
    ).toBe('help.group.reference');
    // Every row of the launcher has its section, Back into service and Organizations among them.
    const rows = sidePanelItems().map(({ id }) => id);
    expect(rows.filter((id) => !shownSections().includes(id))).toEqual(['settings', 'help']);
  });

  it('opens each module, Back into service and Organizations from its section, and the AI settings from the AI section', () => {
    // A section offered only its full guide, a page outside the panel: the
    // reader who had just learnt what a module does had to find it again.
    render(<HelpPage />);
    const opened = [...NAV_GROUPS.flatMap((group) => group.items), TOOL_ITEMS[0]].map(
      (item) => item.id,
    );
    expect(opened).toContain('orgs');
    for (const id of opened) {
      openSection(id);
      mockNavigate.mockClear();
      const button = screen.getByTestId(`help-open-${id}`);
      expect(button.textContent, id).toBe('help.openModule');
      fireEvent.click(button);
      expect(mockNavigate, id).toHaveBeenCalledWith(id);
    }
    openSection('ai');
    mockNavigate.mockClear();
    fireEvent.click(screen.getByTestId('help-open-ai-settings'));
    expect(mockNavigate).toHaveBeenCalledWith('settings', { settingsTab: 'ai' });
    // A section with no page of its own opens none.
    for (const id of ['getting-started', 'safety', 'shortcuts', 'faq', 'troubleshooting']) {
      openSection(id);
      expect(screen.queryByTestId(`help-open-${id}`), id).toBeNull();
    }
  });

  it('puts After a sandbox refresh second, which opens Back into service and says its ten steps one sentence each, in their page’s names, in every language', () => {
    render(<HelpPage />);
    expect(shownSections()[1]).toBe('recovery');
    openSection('recovery');
    expect(screen.getByRole('region', { name: 'help.afterRefresh' })).toBeDefined();
    expect(screen.getByTestId('help-summary-recovery').textContent).toBe('moduleSummary.recovery');
    fireEvent.click(screen.getByTestId('help-open-recovery'));
    expect(mockNavigate).toHaveBeenCalledWith('recovery');
    for (const [lng, bundle] of Object.entries(LOCALES)) {
      const text = bundle.help.recoveryContent;
      const steps = text.split('\n').filter((line) => /^\d+\. /.test(line));
      expect(steps, lng).toHaveLength(RECOVERY_STEP_IDS.length);
      RECOVERY_STEP_IDS.forEach((id, index) => {
        const prefix = `${index + 1}. ${bundle.recovery.step[id]}`;
        expect({ lng, id, named: steps[index].startsWith(prefix) }).toEqual({
          lng,
          id,
          named: true,
        });
        // One sentence: nothing ends one before the line does.
        const sentence = steps[index].slice(prefix.length).replace(/[.。]$/u, '');
        expect({ lng, id, sentences: /[.。!?](?:\s|$)/u.test(sentence) ? 2 : 1 }).toEqual({
          lng,
          id,
          sentences: 1,
        });
      });
      for (const says of [
        bundle.nav.recovery,
        bundle.recovery.before.title,
        bundle.recovery.notProven.title,
      ]) {
        expect({ lng, says, said: text.includes(says) }).toEqual({ lng, says, said: true });
      }
    }
    expect(en.help.afterRefresh).toBe('After a sandbox refresh');
    expect(fr.help.afterRefresh).toBe('Après un rafraîchissement de sandbox');
  });

  it('offers the guided tour and Settings right under the search, above every section', () => {
    // They sat at the foot of the page, under twenty sections and seven links.
    render(<HelpPage />);
    const search = screen.getByTestId('help-search');
    const tour = screen.getByTestId('help-start-tour');
    const settings = screen.getByTestId('help-open-settings');
    const first = screen.getByTestId('help-section-getting-started');
    for (const [before, after] of [
      [search, tour],
      [tour, settings],
      [settings, first],
    ]) {
      expect(before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('lists every G shortcut the panel handles, read from the map it handles them by, each with the page it opens', () => {
    // Three of seventeen were said, as examples.
    render(<HelpPage />);
    openSection('shortcuts');
    const items = within(screen.getByTestId('help-chords')).getAllByRole('listitem');
    const chords = Object.entries(CHORD_MAP);
    expect(items).toHaveLength(chords.length);
    expect(chords.length).toBeGreaterThanOrEqual(17);
    for (const [key, route] of chords) {
      const item = screen.getByTestId(`help-chord-${key}`);
      expect(item.textContent, key).toContain(`nav.${route}`);
    }
  });

  it('opens on the section another page asks for, its search emptied and its header focused, once', () => {
    webviewState.value = { helpSearch: 'staging', helpOpenSection: 'faq' };
    intent.value = { route: 'help', helpSection: 'dataops' };
    const first = render(<HelpPage />);
    expect((screen.getByTestId('help-search') as HTMLInputElement).value).toBe('');
    const header = screen.getByTestId('help-section-dataops').querySelector('button');
    expect(header?.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(header);
    expect(screen.getAllByRole('region')).toHaveLength(1);
    expect(mockClearNavigationIntent).toHaveBeenCalled();
    first.unmount();

    // Read once: the next visit opens on what the reader last left open.
    intent.value = null;
    render(<HelpPage />);
    expect(
      screen
        .getByTestId('help-section-dataops')
        .querySelector('button')
        ?.getAttribute('aria-expanded'),
    ).toBe('true');
  });

  it('opens as it was left when asked for a section it does not have, or by an intent for another page', () => {
    webviewState.value = { helpOpenSection: 'faq' };
    for (const asked of [
      { route: 'help', helpSection: 'grappe' },
      { route: 'settings', helpSection: 'dataops' },
    ]) {
      intent.value = asked;
      const view = render(<HelpPage />);
      expect(
        screen
          .getByTestId('help-section-faq')
          .querySelector('button')
          ?.getAttribute('aria-expanded'),
        JSON.stringify(asked),
      ).toBe('true');
      view.unmount();
    }
  });

  it('names the Reference group in every language', () => {
    for (const [lng, bundle] of Object.entries(LOCALES)) {
      expect(bundle.help.group.reference.length, lng).toBeGreaterThan(0);
    }
    expect(en.help.group.reference).toBe('Reference');
    expect(fr.help.group.reference).toBe('Référence');
  });

  it('draws each module and Organizations with the side panel’s icon, where it drew emoji', () => {
    // A hammer for Forge where the side panel draws a flame, a plane for
    // Autopilot where it draws a rocket, and empty boxes where no colour-emoji
    // font exists. Reports among them, which Help drew before the side panel.
    const panel = sidePanelItems();
    const drawn = new Map(HELP_SECTIONS.map((section) => [section.id, section.icon]));
    const shared = panel.filter(({ id }) => drawn.has(id));
    expect(shared).toHaveLength(15);
    for (const { id, icon } of shared) {
      // By the component itself: lucide names one icon several ways (History).
      const component = (lucide as unknown as Record<string, unknown>)[icon];
      expect(component, `${id}: ${icon}`).toBeDefined();
      expect({ id, same: drawn.get(id) === component }).toEqual({ id, same: true });
    }
    render(<HelpPage />);
    expect(screen.getByTestId('help-page').textContent).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(screen.getByTestId('help-icon-seed').tagName.toLowerCase()).toBe('svg');
  });

  it('names each open section’s region by its header', () => {
    // The region pointed at an id no element had: it had no name.
    render(<HelpPage />);
    for (const section of HELP_SECTIONS) {
      if (section.id !== 'getting-started') {
        fireEvent.click(
          screen.getByTestId(`help-section-${section.id}`).querySelector('button') as HTMLElement,
        );
      }
      const region = screen.getByRole('region', { name: section.titleKey });
      expect(region.id).toBe(`help-content-${section.id}`);
    }
  });

  it('leads a new user from connecting to filling with Seed, cloning with Forge, a checkpoint, then the Monitor, in every language', () => {
    // The order Home and the walkthrough use: an empty org is the problem, and
    // Checkpoints, the way back before a risky run, was not named at all.
    for (const [lng, bundle] of Object.entries(LOCALES)) {
      const steps = bundle.help.gettingStartedContent.split('\n');
      expect(steps[0], lng).toContain(bundle.auth.sfdxImport);
      expect(steps[0], lng).toContain(bundle.auth.oauthWeb);
      expect(steps[1], lng).toMatch(/^2\. .*Seed/);
      expect(steps[1], lng).toContain(bundle.seed.templates.crmStarter.name);
      expect(steps[2], lng).toMatch(/^3\. .*Forge/);
      expect(steps[3], lng).toBe(`4. ${bundle.dataops.checkpointBeforeRisk}`);
      expect(steps[4], lng).toContain(bundle.nav.monitor);
    }
  });

  it('says once, in Safety, in every language, what muting the target’s automation lifts, for how long, and when it is refused', () => {
    // Getting Started said it, a paragraph after its steps; Safety is where
    // the other guards are said.
    for (const [lng, bundle] of Object.entries(LOCALES)) {
      const [box] = bundle.automationMute.box.label.split(/\s[—–]\s/u);
      const mute = bundle.help.safetyContent.split('\n').find((line) => line.includes(box));
      expect(mute, lng).toBeDefined();
      for (const module of ['Seed', 'Forge', 'Sync', 'Autopilot']) {
        expect(mute, lng).toContain(module);
      }
      expect(bundle.help.gettingStartedContent, lng).not.toContain(box);
    }
    for (const says of [
      "Mute the target's automation for this run",
      'permission sets holding the bypasses',
      'flows, processes and workflow rules',
      'For the run alone',
      'takes them back as it ends, even after a failure',
      'Nothing is deactivated',
      'what still runs is listed with why',
      "Refused on a production org and for a user who can't assign permission sets: the run then writes nothing",
    ]) {
      expect(en.help.safetyContent).toContain(says);
    }
  });

  it('says in one Safety section what refuses a production org, Staging, where Production Guard’s answers are kept, the mute and the checkpoint to take first, in every language', () => {
    // Said in pieces across Getting Started, Organizations and the FAQ.
    render(<HelpPage />);
    openSection('safety');
    expect(screen.getByTestId('help-text-safety').textContent).toBe('help.safetyContent');
    for (const [lng, bundle] of Object.entries(LOCALES)) {
      const text = bundle.help.safetyContent;
      // The paragraph Organizations and the FAQ say it in, word for word.
      const production = bundle.help.orgsContent
        .split('\n\n')
        .find((paragraph) => paragraph.includes(bundle.org.staging));
      expect(production, lng).toBeDefined();
      expect(text, lng).toContain(production);
      for (const says of [
        'Production Guard',
        bundle.nav.reports,
        bundle.reports.audit,
        bundle.dataops.checkpointBeforeRisk,
      ]) {
        expect({ lng, says, said: text.includes(says) }).toEqual({ lng, says, said: true });
      }
    }
    expect(en.help.safety).toBe('Safety');
    expect(fr.help.safety).toBe('Sécurité');
    expect(en.help.safetyContent).toContain(
      'Reports → Audit trail records each Production Guard decision with its run.',
    );
  });

  it('has an Organizations section naming the two ways to connect, the Login URL’s My Domain and Staging, in every language', () => {
    // Help had no word on connecting an org, nor that both ways run on the
    // Salesforce CLI.
    for (const [lng, bundle] of Object.entries(LOCALES)) {
      const text = bundle.help.orgsContent;
      for (const label of [
        bundle.auth.sfdxImport,
        bundle.auth.oauthWeb,
        bundle.auth.loginCustom,
        bundle.auth.usernamePassword,
        bundle.org.moreMethods,
        bundle.org.staging,
        'Salesforce CLI (sf)',
      ]) {
        expect({ lng, label, said: text.includes(label) }).toEqual({ lng, label, said: true });
      }
      expect(text, lng).toContain(bundle.help.troubleshooting);
    }
    // A CLI holding no org is how a first run starts, said as information.
    expect(en.help.orgsContent).toContain('said as information, not an error');
    // Username / Password went under More methods: two ways stand first.
    expect(en.help.orgsContent).toContain(
      '- More methods holds Username / Password, which needs no CLI, JWT Bearer and OAuth (Device).',
    );
    expect(en.help.orgsContent).not.toContain('are under More methods');
  });

  it('names a sandbox marked Staging by the badge each language gives it, in every section', () => {
    // The French and Japanese pipeline text said Staging where the badge says
    // Préproduction and ステージング.
    for (const [lng, bundle] of Object.entries(LOCALES)) {
      if (bundle.org.staging === 'Staging') continue;
      const english = Object.entries(bundle.help)
        .filter(([, text]) => typeof text === 'string' && /Staging/.test(text))
        .map(([key]) => key);
      expect({ lng, english }).toEqual({ lng, english: [] });
      expect(bundle.help.automationContent, lng).toContain(bundle.org.staging);
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

  it('says Forge copies and where it writes first, then Rehearse beside Simulate in their captions, then the masking, in every language', () => {
    // It opened on a record type's Id, and named neither Rehearse, nor what is
    // masked by default, nor where Forge may write.
    for (const [lng, bundle] of Object.entries(LOCALES)) {
      const lines = bundle.help.forgeContent.toLowerCase().split('\n');
      expect(lines[1], lng).toContain(asSaid(bundle.forgeRun.simulation.caption));
      // Japanese says the rollback in other words: the Help claims gate
      // (docs/product-claims.test.mjs) refuses ロールバック, a rollback feature's word.
      const rehearsal =
        lng === 'ja'
          ? bundle.forgeRun.rehearsal.caption.split('。')[1]
          : bundle.forgeRun.rehearsal.caption;
      expect(lines[1], lng).toContain(asSaid(rehearsal));
      expect(lines[1], lng).toContain(bundle.forgeRun.rehearsal.action.toLowerCase());
      expect(lines[2], lng).toContain(
        bundle.runResults.contactPoints.neutralizedUnlessKept.toLowerCase(),
      );
      expect(lines[2], lng).toContain(bundle.forge.anonymizePII.toLowerCase());
      expect(lines[3], lng).toContain(bundle.forgeRun.saveTemplate.toLowerCase());
    }
    expect(en.help.forgeContent).toMatch(/^Forge copies a record .* Developer Edition org;/);
  });

  it('says what Seed writes for an Agentforce agent, by the gallery’s own words, in every language', () => {
    for (const [lng, bundle] of Object.entries(LOCALES)) {
      for (const label of [
        bundle.seed.scenario.section.title,
        bundle.seed.scenario.draftCard.title,
        bundle.seed.scenario.confirm.start,
        bundle.seed.scenario.tests.write,
      ]) {
        expect({ lng, label, said: bundle.help.seedContent.includes(label) }).toEqual({
          lng,
          label,
          said: true,
        });
      }
    }
    expect(en.help.seedContent).toContain('SandForge never runs the tests');
  });

  it('says Sync shortly, naming its tabs, its files and the neutralizing, and that a transform rule changes one field, in every language', () => {
    // It promised confidence scores the page never shows, said a rule changed
    // every field of every record, and that value mapping took a table the
    // page could not type, in 2,314 characters.
    for (const [lng, bundle] of Object.entries(LOCALES)) {
      for (const label of [
        bundle.sync.tabs.history,
        bundle.sync.tabs.schedules,
        bundle.sync.fields,
        bundle.sync.realtime.conflictsTitle,
        bundle.sync.autoMap,
        bundle.sync.files.toggle,
        bundle.runRemoval.sync.remove,
      ]) {
        expect({ lng, label, said: bundle.help.syncContent.includes(label) }).toEqual({
          lng,
          label,
          said: true,
        });
      }
    }
    expect(en.help.syncContent).not.toMatch(/confidence|incremental|every field of every record/i);
    expect(en.help.syncContent).toContain('A transform rule changes one field');
    expect(en.help.syncContent).toContain('a rule with no field is refused');
  });

  it('says Compare’s live object lists by their tab’s name, Objects, never Snapshots', () => {
    for (const [lng, bundle] of Object.entries(LOCALES)) {
      expect(bundle.help.compareContent, lng).toContain(`- ${bundle.compare.objects}`);
    }
    expect(en.help.compareContent).not.toContain('Snapshot');
  });

  it('says a DataOps backup is a copy, that Restore asks first, and the template button as it reads, in every language', () => {
    // A backup is no checkpoint: each language's word for one is said beside it.
    const checkpointWord: Record<keyof typeof LOCALES, RegExp> = {
      en: /checkpoint/,
      fr: /point de contrôle/,
      de: /Prüfpunkt/,
      es: /punto de control/,
      ja: /チェックポイント/,
      'pt-BR': /ponto de verificação/,
    };
    for (const [lng, bundle] of Object.entries(LOCALES)) {
      expect(bundle.help.dataopsContent, lng).toContain(bundle.dataops.createTemplate);
      expect(bundle.help.dataopsContent, lng).toMatch(checkpointWord[lng as keyof typeof LOCALES]);
    }
    expect(en.help.dataopsContent).toContain('Create backup, beside the template, copies');
    expect(en.help.dataopsContent).toContain('Restore… asks first');
    expect(en.help.dataopsContent).not.toMatch(/snapshot|Create Template/);
  });

  it('says what Frozen Dataset’s extraction needs, its rules file, and pilots one root record, in every language', () => {
    // The extraction is refused without the file, and Help said nothing of it.
    for (const [lng, bundle] of Object.entries(LOCALES)) {
      expect(bundle.help.frozenContent, lng).toContain(bundle.frozen.rulesFile.create);
      expect(bundle.help.frozenContent, lng).toContain(bundle.frozen.rulesFile.format);
      expect(bundle.help.frozenContent, lng).toContain('~/.sandforge-sas/rules.json');
    }
    expect(en.help.frozenContent).toContain('Pilot on one root record');
    expect(es.help.frozenContent).not.toContain('expediente');
    expect(de.help.frozenContent).not.toContain('Vorgang');
    expect(ja.help.frozenContent).not.toContain('案件');
  });

  it('says Migration converts an SFDMU export.json alone and that Sync writes it, in every language', () => {
    for (const [lng, bundle] of Object.entries(LOCALES)) {
      expect(bundle.help.migrationContent, lng).toContain(bundle.migration.saveSync.openInSync);
      // It offered ".json or .csv file", which the page no longer converts.
      expect(bundle.help.migrationContent, lng).not.toContain('.csv');
    }
    expect(en.help.migrationContent).not.toContain('Running the converted configuration');
  });

  it('names neither NL2SOQL nor Compare’s schema advice, gone, in any language', () => {
    for (const [lng, bundle] of Object.entries(LOCALES)) {
      expect(bundle.help.aiContent, lng).not.toContain('NL2SOQL');
      expect(bundle.help.aiContent, lng).toContain(bundle.seed.scenario.draftCard.title);
    }
    expect(en.help.aiContent).not.toMatch(/schema advice/i);
    expect(fr.help.monitorContent).not.toContain('Limites Governor');
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

  it('says Monitor lists the refreshes SandForge noticed, the newest with Bring back into service…, in every language', () => {
    for (const [lng, bundle] of Object.entries(LOCALES)) {
      const line = bundle.help.monitorContent
        .split('\n')
        .find((said) => said.includes(bundle.monitor.sandboxRefresh.title));
      expect(line, lng).toBeDefined();
      expect(line, lng).toContain(bundle.monitor.sandboxRefresh.recovery.bringBack);
      expect(line, lng).toContain(bundle.monitor.sandboxRefresh.recovery.automate);
    }
  });

  it('says Reports shows the audit trail and the lineage it renders, not that they are coming', () => {
    for (const [lng, bundle] of Object.entries(LOCALES)) {
      expect(bundle.help.reportsContent, lng).toContain(bundle.reports.audit);
      expect(bundle.help.reportsContent, lng).toContain(bundle.reports.lineage);
    }
    expect(en.help.reportsContent).not.toMatch(/coming soon/i);
  });

  it('says what refuses a production org and what Staging is for, in the one sentence the walkthrough says it, in FAQ and Organizations alike', () => {
    // Three texts told three stories: Forge alone refusing, Frozen loads,
    // Checkpoints and Compare's deploy left out, and Staging never explained.
    const sentence =
      "Forge, Frozen Dataset loads, Checkpoints and Compare's deploy refuse a production org; deletes are refused there too; every other write there asks first, and no setting turns that off. A sandbox holding real data (full copy, UAT): open its Edit dialog on Organizations and tick Staging, and Production Guard then asks before every delete, deployment and write over 10,000 records.";
    expect(en.help.faqContent).toContain(sentence);
    expect(en.help.orgsContent).toContain(sentence);
    expect(en.help.faqContent).not.toContain('All destructive operations require confirmation');
    for (const [lng, bundle] of Object.entries(LOCALES)) {
      const said = bundle.help.orgsContent
        .split('\n\n')
        .find((paragraph) => paragraph.includes(bundle.org.staging));
      expect(said, lng).toBeDefined();
      expect(bundle.help.faqContent, lng).toContain(said);
    }
  });

  it('names no setting that turns the production question off, in six languages', () => {
    // It named sandforge.safety.requireProdConfirmation, which turned the
    // question off; every write to a production org now asks, whatever it says.
    for (const [lng, bundle] of Object.entries(LOCALES)) {
      expect(bundle.help.faqContent, lng).not.toContain('requireProdConfirmation');
    }
    expect(en.help.faqContent).toContain('no setting turns that off');
  });

  it('answers first where one empty org starts, and advises a checkpoint before a risky run, not a DataOps backup, in every language', () => {
    // A DataOps backup covers only what the anonymization templates mask.
    for (const [lng, bundle] of Object.entries(LOCALES)) {
      const [question, answer] = bundle.help.faqContent.split('\n');
      expect(question, lng).toMatch(/^[QPF]\s?[:：]/u);
      expect(answer, lng).toContain('Seed');
      expect(answer, lng).toContain(bundle.seed.templates.crmStarter.name);
      expect(bundle.help.faqContent, lng).toContain(bundle.dataops.checkpointBeforeRisk);
    }
    expect(en.help.faqContent).not.toContain('DataOps backup');
  });

  it('says how to get an org connected, in the Salesforce words for its IP restrictions, in every language', () => {
    // It said "Check your IP whitelist settings" and named no SandForge action.
    for (const [lng, bundle] of Object.entries(LOCALES)) {
      const text = bundle.help.troubleshootingContent;
      for (const says of [
        'Login IP Ranges',
        'sf org list',
        'sf org login web --alias my-sandbox',
        'sf org open --target-org my-sandbox',
        bundle.auth.sfdxImport,
        bundle.auth.usernamePassword,
      ]) {
        expect({ lng, says, said: text.includes(says) }).toEqual({ lng, says, said: true });
      }
      expect(text.toLowerCase(), lng).not.toMatch(/whitelist|liste blanche|ホワイトリスト/);
    }
  });

  it('keeps every English section within 1,200 characters', () => {
    // Sync was one block of 2,314 characters, DataOps of 1,652.
    const sections = Object.entries(en.help).flatMap(([key, text]) =>
      key.endsWith('Content') && typeof text === 'string' ? [[key, text] as const] : [],
    );
    expect(sections.length).toBe(HELP_SECTIONS.length);
    expect(
      sections
        .filter(([, text]) => text.length > 1200)
        .map(([key, text]) => `${key}: ${text.length}`),
    ).toEqual([]);
  });

  it('ends each section with its full guide, a page of the docs that is there', () => {
    // Help linked to no page of SandForge's own docs.
    render(<HelpPage />);
    const guided = HELP_SECTIONS.filter((section) => section.guide);
    expect(guided.length).toBe(HELP_SECTIONS.length - 2);
    for (const section of guided) {
      const header = screen
        .getByTestId(`help-section-${section.id}`)
        .querySelector('button') as HTMLElement;
      if (header.getAttribute('aria-expanded') !== 'true') fireEvent.click(header);
      const link = screen.getByTestId(`help-guide-${section.id}`);
      const href = link.getAttribute('href') ?? '';
      expect(href.startsWith(DOCS_URL)).toBe(true);
      const [page, anchor] = href.slice(DOCS_URL.length).split('#');
      const file = join(REPO_ROOT, 'docs', page);
      expect({ page, there: existsSync(file) }).toEqual({ page, there: true });
      if (anchor) {
        const headings = readFileSync(file, 'utf-8')
          .split('\n')
          .filter((line) => /^#{1,6} /.test(line))
          .map((line) =>
            line
              .replace(/^#+ /, '')
              .toLowerCase()
              .replace(/[^\p{L}\p{N} -]/gu, '')
              .replace(/ /g, '-'),
          );
        expect({ page, anchor, there: headings.includes(anchor) }).toEqual({
          page,
          anchor,
          there: true,
        });
      }
      expect(link.getAttribute('target')).toBe('_blank');
    }
  });

  it('links SandForge’s FAQ, guides, issues and site above Salesforce’s resources, under a heading of their own', () => {
    // The Salesforce heading repeated its first card's title, and no link led
    // to SandForge's own docs or issue tracker.
    render(<HelpPage />);
    const hrefs = ['faq', 'guides', 'issue', 'site'].map((id) =>
      screen.getByTestId(`help-link-${id}`).getAttribute('href'),
    );
    expect(hrefs).toEqual([
      `${DOCS_URL}faq.md`,
      `${REPOSITORY_URL}/tree/master/docs/modules`,
      `${REPOSITORY_URL}/issues`,
      'help.siteUrl',
    ]);
    // After the headings of the groups of sections.
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings.slice(-2)).toEqual(['help.sandforgeLinks', 'help.sfResources']);
    const order = screen
      .getByTestId('help-link-site')
      .compareDocumentPosition(screen.getByTestId('sf-link-help.sfDocs'));
    expect(order & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(en.help.sfResources).not.toBe(en.help.sfDocs);
    // The site in the reader's language where it has one.
    expect(fr.help.siteUrl).toBe('https://sandforge.fr/');
    expect(en.help.siteUrl).toBe('https://sandforge.fr/en/');
  });

  it('opens What’s New and the Marketplace changelog from Release Notes, where it said one sentence', () => {
    render(<HelpPage />);
    fireEvent.click(screen.getByText('help.releaseNotes'));
    const changelog = screen.getByTestId('help-open-changelog');
    expect(changelog.getAttribute('href')).toBe(WHATS_NEW_CHANGELOG_URL);
    expect(CHANGELOG_URL).toBe(WHATS_NEW_CHANGELOG_URL);
    expect(changelog.getAttribute('target')).toBe('_blank');
    fireEvent.click(screen.getByTestId('help-show-whats-new'));
    expect(mockSetShowWhatsNew).toHaveBeenCalledWith(true, __APP_VERSION__, undefined, true);
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
    // And where the rest is said.
    expect(screen.getByTestId('help-no-results-faq').getAttribute('href')).toBe(
      `${DOCS_URL}faq.md`,
    );
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
