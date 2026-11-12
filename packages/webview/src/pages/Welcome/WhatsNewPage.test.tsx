import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CHANGELOG_URL, WhatsNewPage, WHATS_NEW, releasesToShow } from './WhatsNewPage';
import en from '../../i18n/locales/en.json';
import fr from '../../i18n/locales/fr.json';
import de from '../../i18n/locales/de.json';

/** The extension manifest, which names the publisher and the extension the Marketplace lists. */
const manifest = JSON.parse(
  readFileSync(resolve(__dirname, '..', '..', '..', '..', 'extension', 'package.json'), 'utf8'),
) as { publisher: string; name: string };

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // A version passed to the sentence shows beside its key.
    t: (key: string, fallback?: unknown) =>
      typeof fallback === 'string'
        ? fallback
        : typeof fallback === 'object' && fallback !== null && 'version' in fallback
          ? `${key}(${String(fallback.version)})`
          : key,
    i18n: { changeLanguage: vi.fn() },
  }),
}));

const mockNavigate = vi.fn();
/* The version last opened, as the extension sent it with whats-new:show. */
const mockSince = vi.hoisted(() => ({ value: '' }));
/* Whether the page was asked from Help, where a release that lists nothing shows the one before. */
const mockStandIn = vi.hoisted(() => ({ value: false }));
vi.mock('../../stores/useAppStore', () => ({
  useAppStore: (
    selector: (s: {
      navigate: typeof mockNavigate;
      whatsNewSince: string;
      whatsNewStandIn: boolean;
    }) => unknown,
  ) =>
    selector({
      navigate: mockNavigate,
      whatsNewSince: mockSince.value,
      whatsNewStandIn: mockStandIn.value,
    }),
}));

/** A version that has highlights to show. */
const LISTED = '1.0.0';

describe('WhatsNewPage', () => {
  beforeEach(() => {
    mockStandIn.value = false;
    mockNavigate.mockClear();
    mockSince.value = '';
  });

  it('should render the page', () => {
    render(<WhatsNewPage version={LISTED} onDismiss={vi.fn()} />);
    expect(screen.getByTestId('whats-new-page')).toBeDefined();
  });

  it('should display the version number', () => {
    render(<WhatsNewPage version={LISTED} onDismiss={vi.fn()} />);
    expect(screen.getByText('SandForge v1.0.0')).toBeDefined();
  });

  it('should display the title', () => {
    render(<WhatsNewPage version={LISTED} onDismiss={vi.fn()} />);
    expect(screen.getByText('onboarding.whatsNewTitle')).toBeDefined();
  });

  it('keys every highlight list by a release version', () => {
    for (const version of Object.keys(WHATS_NEW)) {
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('names a catalogue entry for every highlight of every release', () => {
    // A key with no entry renders as itself, so a typo ships as
    // "onboarding.whatsNew.speed" on the panel every upgrader sees.
    const lookup = (key: string) =>
      key
        .split('.')
        .reduce<unknown>(
          (node, part) => (node as Record<string, unknown> | undefined)?.[part],
          en as unknown,
        );
    for (const [version, features] of Object.entries(WHATS_NEW)) {
      for (const feature of features) {
        expect(lookup(feature.titleKey), `${version} › ${feature.titleKey}`).toBeTypeOf('string');
        expect(lookup(feature.descKey), `${version} › ${feature.descKey}`).toBeTypeOf('string');
      }
    }
  });

  it('renders the highlights listed for its own version', () => {
    render(<WhatsNewPage version={LISTED} onDismiss={vi.fn()} />);
    for (const feature of WHATS_NEW[LISTED] ?? []) {
      expect(screen.getByText(feature.titleKey)).toBeDefined();
      expect(screen.getByText(feature.descKey)).toBeDefined();
    }
  });

  it('shows nothing and closes itself when its version has no highlights', () => {
    const onDismiss = vi.fn();
    const { container } = render(<WhatsNewPage version="1.22.0" onDismiss={onDismiss} />);
    // An upgrade to a release with no entry used to show another release's
    // list, stamped with the current version number.
    expect(screen.queryByTestId('whats-new-page')).toBeNull();
    expect(container.textContent).toBe('');
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('does not close itself when its version has highlights', () => {
    const onDismiss = vi.fn();
    render(<WhatsNewPage version={LISTED} onDismiss={onDismiss} />);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('should render the dismiss button', () => {
    render(<WhatsNewPage version={LISTED} onDismiss={vi.fn()} />);
    expect(screen.getByTestId('whats-new-dismiss')).toBeDefined();
  });

  it('should call onDismiss when the dismiss button is clicked', () => {
    const onDismiss = vi.fn();
    render(<WhatsNewPage version={LISTED} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByTestId('whats-new-dismiss'));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('should render category-specific icons', () => {
    render(<WhatsNewPage version={LISTED} onDismiss={vi.fn()} />);
    // Feature entries have the sparkle icon (feature category)
    expect(screen.getAllByTestId('icon-feature').length).toBeGreaterThan(0);
    // Improvement entries have the arrow icon (improvement category)
    expect(screen.getAllByTestId('icon-improvement').length).toBeGreaterThan(0);
  });

  it('should render "Try it now" buttons for features with navigation', () => {
    render(<WhatsNewPage version={LISTED} onDismiss={vi.fn()} />);
    expect(screen.getByTestId('try-it-onboarding.whatsNew.i18n')).toBeDefined();
    expect(screen.getByTestId('try-it-onboarding.whatsNew.help')).toBeDefined();
    expect(screen.getByTestId('try-it-onboarding.whatsNew.onboarding')).toBeDefined();
  });

  it('should navigate and dismiss when "Try it now" is clicked', () => {
    const onDismiss = vi.fn();
    render(<WhatsNewPage version={LISTED} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByTestId('try-it-onboarding.whatsNew.i18n'));
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(mockNavigate).toHaveBeenCalledWith('settings');
  });

  it('links the full changelog to the Changelog tab of the Marketplace page', () => {
    render(<WhatsNewPage version={LISTED} onDismiss={vi.fn()} />);
    // A button with no handler: clicking "View full changelog" did nothing.
    const link = screen.getByTestId('changelog-link');
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe(CHANGELOG_URL);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.textContent).toContain('onboarding.viewChangelog');
  });

  it('names the extension the manifest publishes in the changelog address', () => {
    expect(CHANGELOG_URL).toBe(
      `https://marketplace.visualstudio.com/items/${manifest.publisher}.${manifest.name}/changelog`,
    );
  });

  it('lists every release since the version last opened, newest first', () => {
    // An upgrade from 1.68 to 1.70 showed 1.70 alone: what 1.69 brought was
    // never told.
    mockSince.value = '1.68.0';
    render(<WhatsNewPage version="1.70.0" onDismiss={vi.fn()} />);

    const shown = [...document.querySelectorAll('[data-testid^="release-"]')].map((node) =>
      node.getAttribute('data-testid'),
    );
    expect(shown).toEqual(['release-1.70.0', 'release-1.69.0']);
    for (const feature of [...(WHATS_NEW['1.70.0'] ?? []), ...(WHATS_NEW['1.69.0'] ?? [])]) {
      expect(screen.getByText(feature.titleKey)).toBeDefined();
    }
    for (const feature of WHATS_NEW['1.68.0'] ?? []) {
      expect(screen.queryByText(feature.titleKey)).toBeNull();
    }
    expect(screen.getByRole('heading', { name: '1.69.0' })).toBeDefined();
    expect(screen.getByTestId('whats-new-since').textContent).toBe(
      'onboarding.whatsNewSince(1.68.0)',
    );
  });

  it('shows the releases an upgrade skipped even when the current one lists nothing', () => {
    const onDismiss = vi.fn();
    mockSince.value = '1.69.0';
    render(<WhatsNewPage version="1.70.4" onDismiss={onDismiss} />);

    expect(screen.getByTestId('release-1.70.0')).toBeDefined();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('shows the current release alone, with no version headings, after a one-release upgrade', () => {
    mockSince.value = '1.69.0';
    render(<WhatsNewPage version="1.70.0" onDismiss={vi.fn()} />);

    expect(screen.getByTestId('release-1.70.0')).toBeDefined();
    expect(screen.queryByTestId('release-1.69.0')).toBeNull();
    expect(screen.queryByRole('heading', { name: '1.70.0' })).toBeNull();
    expect(screen.queryByTestId('whats-new-since')).toBeNull();
  });

  it('lists the current release alone when the version last opened is unknown, later or not a version', () => {
    for (const since of [undefined, '', '1.71.0', 'next']) {
      expect(releasesToShow('1.70.0', since).map((release) => release.version)).toEqual(['1.70.0']);
    }
  });

  it('shows the newest release listed before a patch release that lists nothing, as Help asks with no version last opened', () => {
    expect(WHATS_NEW['1.70.1']).toBeUndefined();
    expect(releasesToShow('1.70.1', undefined, true).map((release) => release.version)).toEqual([
      '1.70.0',
    ]);
    expect(releasesToShow('1.70.1', '', true).map((release) => release.version)).toEqual([
      '1.70.0',
    ]);
    expect(releasesToShow('0.0.1', undefined, true)).toEqual([]);
    expect(releasesToShow('next', undefined, true)).toEqual([]);
    // After an update, a release with nothing of its own still shows nothing.
    expect(releasesToShow('1.70.1')).toEqual([]);
  });

  it('shows from Help the release a patch release stands for, and closes on an update to it', () => {
    const onDismiss = vi.fn();
    mockStandIn.value = true;
    const { unmount } = render(<WhatsNewPage version="1.70.1" onDismiss={onDismiss} />);
    expect(screen.getByTestId('release-1.70.0')).toBeDefined();
    expect(onDismiss).not.toHaveBeenCalled();
    unmount();
    mockStandIn.value = false;
    render(<WhatsNewPage version="1.70.1" onDismiss={onDismiss} />);
    expect(screen.queryByTestId('whats-new-page')).toBeNull();
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('closes itself when no release since the version last opened lists anything', () => {
    const onDismiss = vi.fn();
    mockSince.value = '1.70.0';
    render(<WhatsNewPage version="1.70.1" onDismiss={onDismiss} />);

    expect(screen.queryByTestId('whats-new-page')).toBeNull();
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('compares versions by their numbers, not as text', () => {
    // As text, 1.9.0 sorts after 1.10.0 and 1.100.0 before 1.20.0.
    expect(releasesToShow('1.39.12', '1.39.9').map((release) => release.version)).toEqual([
      '1.39.12',
      '1.39.11',
      '1.39.10',
    ]);
  });

  it('should not render "Try it now" for features without navigation', () => {
    render(<WhatsNewPage version={LISTED} onDismiss={vi.fn()} />);
    // a11y and branding features have no navigateTo
    expect(screen.queryByTestId('try-it-onboarding.whatsNew.a11y')).toBeNull();
    expect(screen.queryByTestId('try-it-onboarding.whatsNew.branding')).toBeNull();
  });

  it('names Rehearse as the Review button does in French and German, now that skipped releases show', () => {
    // « Répéter » read "repeat" and „Proben“ "samples"; the button became
    // « Essai à blanc » and „Probelauf“, and an upgrade from before 1.43 lists
    // this entry again.
    for (const [catalogue, retired] of [
      [fr, /Répéter/],
      [de, /\bProben\b/],
    ] as const) {
      const entry = catalogue.onboarding.whatsNew.gaps1430Desc;
      expect(entry).toContain(catalogue.forgeRun.rehearsal.action);
      expect(entry).not.toMatch(retired);
    }
  });
});
