import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WhatsNewPage, WHATS_NEW } from './WhatsNewPage';
import en from '../../i18n/locales/en.json';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { changeLanguage: vi.fn() },
  }),
}));

const mockNavigate = vi.fn();
vi.mock('../../stores/useAppStore', () => ({
  useAppStore: (selector: (s: { navigate: typeof mockNavigate }) => unknown) =>
    selector({ navigate: mockNavigate }),
}));

/** A version that has highlights to show. */
const LISTED = '1.0.0';

describe('WhatsNewPage', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
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

  it('should render the changelog link', () => {
    render(<WhatsNewPage version={LISTED} onDismiss={vi.fn()} />);
    expect(screen.getByTestId('changelog-link')).toBeDefined();
    expect(screen.getByText('onboarding.viewChangelog')).toBeDefined();
  });

  it('should not render "Try it now" for features without navigation', () => {
    render(<WhatsNewPage version={LISTED} onDismiss={vi.fn()} />);
    // a11y and branding features have no navigateTo
    expect(screen.queryByTestId('try-it-onboarding.whatsNew.a11y')).toBeNull();
    expect(screen.queryByTestId('try-it-onboarding.whatsNew.branding')).toBeNull();
  });
});
