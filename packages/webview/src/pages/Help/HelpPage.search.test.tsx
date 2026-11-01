import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import en from '../../i18n/locales/en.json';
import { HelpPage, searchPatterns } from './HelpPage';

/** A key of the English catalogue, as the page reads it, its `{{…}}` filled in. */
function english(key: string, options?: unknown): string {
  let node: unknown = en;
  for (const part of key.split('.')) {
    node = (node as Record<string, unknown> | undefined)?.[part];
  }
  if (typeof node !== 'string') return key;
  const values = (typeof options === 'object' && options !== null ? options : {}) as Record<
    string,
    unknown
  >;
  return node.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values[name] ?? ''));
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: english, i18n: { changeLanguage: vi.fn(), language: 'en' } }),
}));

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

vi.mock('../../stores/useAppStore', () => {
  const getState = () => ({
    navigate: vi.fn(),
    setShowWelcome: vi.fn(),
    setShowWhatsNew: vi.fn(),
  });
  const useAppStore = (selector: (s: ReturnType<typeof getState>) => unknown): unknown =>
    selector(getState());
  useAppStore.getState = getState;
  return { useAppStore };
});

/** The ids of the sections the page shows. */
const shownSections = (): string[] =>
  screen
    .getAllByTestId(/^help-section-/)
    .map((section) => (section.getAttribute('data-testid') ?? '').replace('help-section-', ''));

const search = (query: string): void => {
  fireEvent.change(screen.getByTestId('help-search'), { target: { value: query } });
};

describe('Help search, in the English the page renders', () => {
  beforeEach(() => {
    webviewState.value = undefined;
  });

  it('finds a word by its start, so "cli" finds the Salesforce CLI and not every "click"', () => {
    // A substring match found every section saying "click": Monitor's text,
    // and the how-to of almost every module.
    expect(en.help.monitorContent).toContain('click');
    expect(en.help.monitorContent.toLowerCase()).not.toMatch(/(?<![\p{L}\p{N}])cli(?!ck)/u);
    render(<HelpPage />);
    search('cli');
    const shown = shownSections();
    expect(shown).toEqual(expect.arrayContaining(['getting-started', 'orgs', 'troubleshooting']));
    expect(shown).not.toContain('monitor');
    expect(shown).not.toContain('compare');
  });

  it('opens every section it finds and marks there what it found', () => {
    // The sections stayed closed, and nothing said why one had matched.
    render(<HelpPage />);
    search('staging');
    const shown = shownSections();
    expect(shown).toEqual(expect.arrayContaining(['orgs', 'faq', 'frozen']));
    for (const id of shown) {
      const section = screen.getByTestId(`help-section-${id}`);
      expect(section.querySelector('button')?.getAttribute('aria-expanded'), id).toBe('true');
      const marks = within(section).getAllByText((_, el) => el?.tagName === 'MARK');
      expect(marks.length, id).toBeGreaterThan(0);
      for (const mark of marks) expect(mark.textContent?.toLowerCase()).toBe('staging');
    }
  });

  it('marks what it found in a module’s how-to as in its text', () => {
    render(<HelpPage />);
    search('earlier seeds');
    const steps = screen.getByTestId('how-to-steps-seed');
    expect(
      Array.from(steps.querySelectorAll('mark')).map((mark) => mark.textContent?.toLowerCase()),
    ).toEqual(expect.arrayContaining(['earlier', 'seeds']));
  });

  it('closes a found section by its header, and opens it again, while the search stays', () => {
    render(<HelpPage />);
    search('staging');
    const header = screen.getByTestId('help-section-orgs').querySelector('button') as HTMLElement;
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(
      screen.getByTestId('help-section-faq').querySelector('button')?.getAttribute('aria-expanded'),
    ).toBe('true');
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('true');
    // Cleared, the page shows the one section it showed before the search.
    search('');
    expect(screen.getAllByRole('region')).toHaveLength(1);
  });

  it('finds a section only when it holds every word of the query', () => {
    render(<HelpPage />);
    search('login ranges');
    expect(shownSections()).toEqual(['troubleshooting']);
  });

  it('says where the rest is when nothing is found', () => {
    render(<HelpPage />);
    search('xyzzy');
    expect(screen.getByTestId('help-no-results').textContent).toContain(en.help.notFoundFaq);
  });
});

describe('searchPatterns', () => {
  it('matches a short word whole and a longer one at a word’s start, in any case, never inside a word', () => {
    const [cli] = searchPatterns('cli');
    expect(cli.test('the Salesforce CLI (sf)')).toBe(true);
    expect(cli.test('click Evaluate')).toBe(false);
    expect(cli.test('the CLI.')).toBe(true);
    const [check] = searchPatterns('check');
    expect(check.test('take a checkpoint')).toBe(true);
    const [inside] = searchPatterns('valuate');
    expect(inside.test('click Evaluate')).toBe(false);
  });

  it('takes a word after an accent or a dash for the start of one', () => {
    const [word] = searchPatterns('contrôle');
    expect(word.test('point de contrôle')).toBe(true);
    expect(word.test('autocontrôle')).toBe(false);
    const [after] = searchPatterns('lève');
    expect(after.test('Élève')).toBe(false);
  });

  it('finds a Japanese word anywhere, as the language puts no space between words', () => {
    const [word] = searchPatterns('ポイント');
    expect(word.test('チェックポイントを作成')).toBe(true);
  });

  it('reads the query’s special characters as themselves', () => {
    const [dotted] = searchPatterns('sf.org');
    expect(dotted.test('sf org list')).toBe(false);
    expect(dotted.test('sf.org')).toBe(true);
    expect(searchPatterns('   ')).toEqual([]);
  });
});
