import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LoadingScreen } from './LoadingScreen';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe('LoadingScreen', () => {
  it('should render the loading screen container', () => {
    render(<LoadingScreen progress={50} step="Connecting..." />);
    const container = screen.getByTestId('loading-screen');
    expect(container).toBeDefined();
  });

  it('should display the step label', () => {
    render(<LoadingScreen progress={30} step="Loading schema..." />);
    const stepEl = screen.getByTestId('loading-step');
    expect(stepEl.textContent).toBe('Loading schema...');
  });

  it('should render a progress bar with correct aria attributes', () => {
    render(<LoadingScreen progress={75} step="Ready!" />);
    const progressBar = screen.getByRole('progressbar');
    expect(progressBar.getAttribute('aria-valuenow')).toBe('75');
    expect(progressBar.getAttribute('aria-valuemin')).toBe('0');
    expect(progressBar.getAttribute('aria-valuemax')).toBe('100');
  });

  it('should clamp progress to 0-100 range', () => {
    const { rerender } = render(<LoadingScreen progress={-10} step="test" />);
    let progressBar = screen.getByRole('progressbar');
    expect(progressBar.getAttribute('aria-valuenow')).toBe('0');

    rerender(<LoadingScreen progress={150} step="test" />);
    progressBar = screen.getByRole('progressbar');
    expect(progressBar.getAttribute('aria-valuenow')).toBe('100');
  });

  it('should have role status and aria-live polite', () => {
    render(<LoadingScreen progress={0} step="Starting..." />);
    const container = screen.getByTestId('loading-screen');
    expect(container.getAttribute('role')).toBe('status');
    expect(container.getAttribute('aria-live')).toBe('polite');
  });

  it('should render the Logo component', () => {
    render(<LoadingScreen progress={0} step="test" />);
    const logo = screen.getByRole('img');
    expect(logo).toBeDefined();
  });

  it('should display SandForge heading', () => {
    render(<LoadingScreen progress={0} step="test" />);
    const heading = screen.getByText('SandForge');
    expect(heading).toBeDefined();
  });

  it('should apply custom className', () => {
    render(<LoadingScreen progress={0} step="test" className="my-custom" />);
    const container = screen.getByTestId('loading-screen');
    expect(container.className).toContain('my-custom');
  });
});
