import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WhatsNewPage } from './WhatsNewPage';

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

describe('WhatsNewPage', () => {
  it('should render the page', () => {
    render(<WhatsNewPage version="1.2.0" onDismiss={vi.fn()} />);
    expect(screen.getByTestId('whats-new-page')).toBeDefined();
  });

  it('should display the version number', () => {
    render(<WhatsNewPage version="1.2.0" onDismiss={vi.fn()} />);
    expect(screen.getByText('SandForge v1.2.0')).toBeDefined();
  });

  it('should display the title', () => {
    render(<WhatsNewPage version="1.0.0" onDismiss={vi.fn()} />);
    expect(screen.getByText('onboarding.whatsNewTitle')).toBeDefined();
  });

  it('should render all feature entries', () => {
    render(<WhatsNewPage version="1.0.0" onDismiss={vi.fn()} />);
    expect(screen.getByText('onboarding.whatsNew.i18n')).toBeDefined();
    expect(screen.getByText('onboarding.whatsNew.help')).toBeDefined();
    expect(screen.getByText('onboarding.whatsNew.onboarding')).toBeDefined();
    expect(screen.getByText('onboarding.whatsNew.a11y')).toBeDefined();
    expect(screen.getByText('onboarding.whatsNew.branding')).toBeDefined();
  });

  it('should render feature descriptions', () => {
    render(<WhatsNewPage version="1.0.0" onDismiss={vi.fn()} />);
    expect(screen.getByText('onboarding.whatsNew.i18nDesc')).toBeDefined();
    expect(screen.getByText('onboarding.whatsNew.helpDesc')).toBeDefined();
  });

  it('should render the dismiss button', () => {
    render(<WhatsNewPage version="1.0.0" onDismiss={vi.fn()} />);
    expect(screen.getByTestId('whats-new-dismiss')).toBeDefined();
  });

  it('should call onDismiss when the dismiss button is clicked', () => {
    const onDismiss = vi.fn();
    render(<WhatsNewPage version="1.0.0" onDismiss={onDismiss} />);
    fireEvent.click(screen.getByTestId('whats-new-dismiss'));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('should display a different version when prop changes', () => {
    const { rerender } = render(<WhatsNewPage version="1.0.0" onDismiss={vi.fn()} />);
    expect(screen.getByText('SandForge v1.0.0')).toBeDefined();
    rerender(<WhatsNewPage version="2.0.0" onDismiss={vi.fn()} />);
    expect(screen.getByText('SandForge v2.0.0')).toBeDefined();
  });

  it('should render category-specific icons', () => {
    render(<WhatsNewPage version="1.0.0" onDismiss={vi.fn()} />);
    // Feature entries have the sparkle icon (feature category)
    expect(screen.getAllByTestId('icon-feature').length).toBeGreaterThan(0);
    // Improvement entries have the arrow icon (improvement category)
    expect(screen.getAllByTestId('icon-improvement').length).toBeGreaterThan(0);
  });

  it('should render "Try it now" buttons for features with navigation', () => {
    render(<WhatsNewPage version="1.0.0" onDismiss={vi.fn()} />);
    expect(screen.getByTestId('try-it-onboarding.whatsNew.i18n')).toBeDefined();
    expect(screen.getByTestId('try-it-onboarding.whatsNew.help')).toBeDefined();
    expect(screen.getByTestId('try-it-onboarding.whatsNew.onboarding')).toBeDefined();
  });

  it('should navigate and dismiss when "Try it now" is clicked', () => {
    const onDismiss = vi.fn();
    render(<WhatsNewPage version="1.0.0" onDismiss={onDismiss} />);
    fireEvent.click(screen.getByTestId('try-it-onboarding.whatsNew.i18n'));
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(mockNavigate).toHaveBeenCalledWith('settings');
  });

  it('should render the changelog link', () => {
    render(<WhatsNewPage version="1.0.0" onDismiss={vi.fn()} />);
    expect(screen.getByTestId('changelog-link')).toBeDefined();
    expect(screen.getByText('onboarding.viewChangelog')).toBeDefined();
  });

  it('should not render "Try it now" for features without navigation', () => {
    render(<WhatsNewPage version="1.0.0" onDismiss={vi.fn()} />);
    // a11y and branding features have no navigateTo
    expect(screen.queryByTestId('try-it-onboarding.whatsNew.a11y')).toBeNull();
    expect(screen.queryByTestId('try-it-onboarding.whatsNew.branding')).toBeNull();
  });
});
