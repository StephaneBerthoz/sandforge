import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { HelpPage } from './HelpPage';

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

describe('HelpPage', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
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

  it('should navigate to welcome when Start Guided Tour is clicked', () => {
    render(<HelpPage />);
    fireEvent.click(screen.getByTestId('help-start-tour'));
    expect(mockNavigate).toHaveBeenCalledWith('welcome');
  });
});
