import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { KPICard } from './KPICard';

describe('KPICard', () => {
  it('should render with data-testid', () => {
    render(<KPICard icon="dashboard" label="API Calls" value={1234} />);
    expect(screen.getByTestId('kpi-card')).toBeDefined();
  });

  it('should render the icon', () => {
    render(<KPICard icon="dashboard" label="API Calls" value={1234} />);
    expect(screen.getByTestId('icon-dashboard')).toBeDefined();
  });

  it('should render the label', () => {
    render(<KPICard icon="dashboard" label="API Calls" value={1234} />);
    expect(screen.getByText('API Calls')).toBeDefined();
  });

  it('should render a string value', () => {
    render(<KPICard icon="database" label="Records" value="12,345" />);
    expect(screen.getByTestId('kpi-value').textContent).toBe('12,345');
  });

  it('should render a numeric value', () => {
    render(<KPICard icon="database" label="Records" value={500} />);
    expect(screen.getByTestId('kpi-value').textContent).toBe('500');
  });

  it('should render subtitle when provided', () => {
    render(<KPICard icon="sync" label="Sync" value={83} subtitle="/15,000" />);
    expect(screen.getByTestId('kpi-subtitle')).toBeDefined();
    expect(screen.getByText('/15,000')).toBeDefined();
  });

  it('should not render subtitle when not provided', () => {
    render(<KPICard icon="sync" label="Sync" value={83} />);
    expect(screen.queryByTestId('kpi-subtitle')).toBeNull();
  });

  it('should render progress bar when progress is provided', () => {
    render(<KPICard icon="sync" label="Sync" value={50} progress={50} />);
    expect(screen.getByRole('progressbar')).toBeDefined();
  });

  it('should not render progress bar when progress is not provided', () => {
    render(<KPICard icon="sync" label="Sync" value={50} />);
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('should apply custom className', () => {
    render(<KPICard icon="dashboard" label="Test" value={0} className="my-custom-class" />);
    const card = screen.getByTestId('kpi-card');
    expect(card.className).toContain('my-custom-class');
  });

  it('should default to "default" variant', () => {
    render(<KPICard icon="dashboard" label="Test" value={0} />);
    const card = screen.getByTestId('kpi-card');
    expect(card).toBeDefined();
  });

  it('should apply variant accent color to icon wrapper', () => {
    const { container } = render(
      <KPICard icon="error" label="Errors" value={5} variant="error" />,
    );
    const iconWrapper = container.querySelector('[data-testid="icon-error"]')?.parentElement;
    expect(iconWrapper?.style.color).toBe('var(--sf-error)');
  });

  it('should pass variant to ProgressBar', () => {
    render(
      <KPICard icon="warning" label="Warnings" value={3} progress={75} variant="warning" />,
    );
    const progressbar = screen.getByRole('progressbar');
    expect(progressbar).toBeDefined();
  });

  it('should not render sparkline when sparklineData is not provided', () => {
    render(<KPICard icon="dashboard" label="Test" value={0} />);
    expect(screen.queryByTestId('kpi-sparkline')).toBeNull();
  });

  it('should render sparkline when sparklineData has 2+ points', () => {
    render(<KPICard icon="dashboard" label="Test" value={0} sparklineData={[10, 20, 30, 40]} />);
    expect(screen.getByTestId('kpi-sparkline')).toBeDefined();
    expect(screen.getByTestId('sparkline')).toBeDefined();
  });

  it('should not render sparkline when sparklineData has only 1 point', () => {
    render(<KPICard icon="dashboard" label="Test" value={0} sparklineData={[50]} />);
    expect(screen.queryByTestId('kpi-sparkline')).toBeNull();
  });

  it('should show trend arrow for up direction', () => {
    render(<KPICard icon="dashboard" label="Test" value={0} trendDirection="up" />);
    const arrow = screen.getByTestId('trend-arrow');
    expect(arrow).toBeDefined();
    expect(arrow.querySelector('svg')).toBeDefined();
    expect(arrow.style.color).toBe('var(--sf-error)');
  });

  it('should show trend arrow for down direction', () => {
    render(<KPICard icon="dashboard" label="Test" value={0} trendDirection="down" />);
    const arrow = screen.getByTestId('trend-arrow');
    expect(arrow).toBeDefined();
    expect(arrow.querySelector('svg')).toBeDefined();
    expect(arrow.style.color).toBe('var(--sf-success)');
  });

  it('should show trend arrow for stable direction', () => {
    render(<KPICard icon="dashboard" label="Test" value={0} trendDirection="stable" />);
    const arrow = screen.getByTestId('trend-arrow');
    expect(arrow).toBeDefined();
    expect(arrow.querySelector('svg')).toBeDefined();
    expect(arrow.style.color).toBe('var(--sf-text-muted)');
  });

  it('should not show trend arrow when trendDirection is not provided', () => {
    render(<KPICard icon="dashboard" label="Test" value={0} />);
    expect(screen.queryByTestId('trend-arrow')).toBeNull();
  });

  it('should show trend warning text', () => {
    render(<KPICard icon="dashboard" label="Test" value={0} trendWarning="Limit reached in ~2h" />);
    const warning = screen.getByTestId('trend-warning');
    expect(warning).toBeDefined();
    expect(warning.textContent).toBe('Limit reached in ~2h');
  });

  it('should not show trend warning when not provided', () => {
    render(<KPICard icon="dashboard" label="Test" value={0} />);
    expect(screen.queryByTestId('trend-warning')).toBeNull();
  });

  it('should apply accentColor prop to icon wrapper when provided', () => {
    const { container } = render(
      <KPICard icon="dashboard" label="Test" value={0} accentColor="var(--custom-accent)" />,
    );
    const iconWrapper = container.querySelector('[data-testid="icon-dashboard"]')?.parentElement;
    expect(iconWrapper?.style.color).toBe('var(--custom-accent)');
  });

  it('should use accentColor prop over variant color', () => {
    const { container } = render(
      <KPICard icon="dashboard" label="Test" value={0} variant="error" accentColor="var(--custom-accent)" />,
    );
    const iconWrapper = container.querySelector('[data-testid="icon-dashboard"]')?.parentElement;
    expect(iconWrapper?.style.color).toBe('var(--custom-accent)');
  });

  it('should apply tabular-nums class to value element', () => {
    render(<KPICard icon="dashboard" label="Test" value={1234} />);
    const valueEl = screen.getByTestId('kpi-value');
    expect(valueEl.className).toContain('tabular-nums');
  });
});
