import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EmptyState } from './EmptyState';

describe('EmptyState', () => {
  it('should render title', () => {
    render(<EmptyState title="No data found" />);
    expect(screen.getByText('No data found')).toBeDefined();
  });

  it('should render description when provided', () => {
    render(<EmptyState title="Empty" description="Nothing here yet" />);
    expect(screen.getByText('Nothing here yet')).toBeDefined();
  });

  it('should render icon when provided', () => {
    render(<EmptyState title="Empty" icon={<span data-testid="icon">icon</span>} />);
    expect(screen.getByTestId('icon')).toBeDefined();
  });

  it('should render action slot', () => {
    render(<EmptyState title="No orgs" action={<button>Connect Org</button>} />);
    expect(screen.getByText('Connect Org')).toBeDefined();
  });

  it('should not render description when not provided', () => {
    const { container } = render(<EmptyState title="Empty" />);
    const pElements = container.querySelectorAll('p');
    expect(pElements.length).toBe(0);
  });

  it('should merge custom className', () => {
    const { container } = render(<EmptyState title="Empty" className="min-h-[400px]" />);
    expect(container.firstChild).toBeDefined();
    expect((container.firstChild as HTMLElement).className).toContain('min-h-[400px]');
  });

  it('should render module-specific SVG illustration for seed', () => {
    render(<EmptyState title="No templates" module="seed" />);
    expect(screen.getByTestId('empty-illustration-seed')).toBeDefined();
    expect(screen.getByTestId('illustration-seed')).toBeDefined();
  });

  it('should render module-specific SVG illustration for sync', () => {
    render(<EmptyState title="No syncs" module="sync" />);
    expect(screen.getByTestId('illustration-sync')).toBeDefined();
  });

  it('should render module-specific SVG illustration for monitor', () => {
    render(<EmptyState title="No data" module="monitor" />);
    expect(screen.getByTestId('illustration-monitor')).toBeDefined();
  });

  it('should render module-specific SVG illustration for compare', () => {
    render(<EmptyState title="No comparisons" module="compare" />);
    expect(screen.getByTestId('illustration-compare')).toBeDefined();
  });

  it('should render module-specific SVG illustration for dataops', () => {
    render(<EmptyState title="No backups" module="dataops" />);
    expect(screen.getByTestId('illustration-dataops')).toBeDefined();
  });

  it('should render module-specific SVG illustration for automation', () => {
    render(<EmptyState title="No pipelines" module="automation" />);
    expect(screen.getByTestId('illustration-automation')).toBeDefined();
  });

  it('should render module-specific SVG illustration for forge', () => {
    render(<EmptyState title="No schema" module="forge" />);
    expect(screen.getByTestId('empty-illustration-forge')).toBeDefined();
    expect(screen.getByTestId('illustration-forge')).toBeDefined();
  });

  it('should render module-specific SVG illustration for autopilot', () => {
    render(<EmptyState title="No autopilot" module="autopilot" />);
    expect(screen.getByTestId('empty-illustration-autopilot')).toBeDefined();
    expect(screen.getByTestId('illustration-autopilot')).toBeDefined();
  });

  it('should prefer module illustration over custom icon', () => {
    render(
      <EmptyState title="Test" module="seed" icon={<span data-testid="custom-icon">icon</span>} />,
    );
    expect(screen.getByTestId('illustration-seed')).toBeDefined();
    expect(screen.queryByTestId('custom-icon')).toBeNull();
  });

  it('should render encouragement message when provided', () => {
    render(<EmptyState title="Empty" encouragement="You are just getting started!" />);
    expect(screen.getByTestId('empty-encouragement')).toBeDefined();
    expect(screen.getByText('You are just getting started!')).toBeDefined();
  });

  it('should not render encouragement when not provided', () => {
    render(<EmptyState title="Empty" />);
    expect(screen.queryByTestId('empty-encouragement')).toBeNull();
  });

  it('should render primary action button when actionLabel and onAction are provided', () => {
    const onAction = vi.fn();
    render(<EmptyState title="No templates" actionLabel="Create template" onAction={onAction} />);
    const button = screen.getByTestId('empty-action-button');
    expect(button).toBeDefined();
    expect(button.textContent).toBe('Create template');
    fireEvent.click(button);
    expect(onAction).toHaveBeenCalledOnce();
  });

  it('should not render action button when actionLabel is missing', () => {
    render(<EmptyState title="Empty" onAction={vi.fn()} />);
    expect(screen.queryByTestId('empty-action-button')).toBeNull();
  });

  it('should render documentation link when docLabel and onDocClick are provided', () => {
    const onDocClick = vi.fn();
    render(<EmptyState title="Empty" docLabel="View docs" onDocClick={onDocClick} />);
    const link = screen.getByTestId('empty-doc-link');
    expect(link.textContent).toBe('View docs');
    fireEvent.click(link);
    expect(onDocClick).toHaveBeenCalledOnce();
  });

  it('should render guided tour link when tourLabel and onTourClick are provided', () => {
    const onTourClick = vi.fn();
    render(<EmptyState title="Empty" tourLabel="Start tour" onTourClick={onTourClick} />);
    const link = screen.getByTestId('empty-tour-link');
    expect(link.textContent).toBe('Start tour');
    fireEvent.click(link);
    expect(onTourClick).toHaveBeenCalledOnce();
  });

  it('should not render links when not provided', () => {
    render(<EmptyState title="Empty" />);
    expect(screen.queryByTestId('empty-doc-link')).toBeNull();
    expect(screen.queryByTestId('empty-tour-link')).toBeNull();
  });

  it('should render ordered steps when provided', () => {
    render(
      <EmptyState title="Empty" steps={['First connect', 'Then paste an ID', 'Then forge']} />,
    );
    expect(screen.getByTestId('empty-steps')).toBeDefined();
    expect(screen.getByTestId('empty-step-0').textContent).toContain('First connect');
    expect(screen.getByTestId('empty-step-1').textContent).toContain('Then paste an ID');
    expect(screen.getByTestId('empty-step-2').textContent).toContain('Then forge');
  });

  it('should number the steps starting at 1', () => {
    render(<EmptyState title="Empty" steps={['Alpha', 'Beta']} />);
    expect(screen.getByTestId('empty-step-0').textContent).toContain('1');
    expect(screen.getByTestId('empty-step-1').textContent).toContain('2');
  });

  it('should not render steps when not provided', () => {
    render(<EmptyState title="Empty" />);
    expect(screen.queryByTestId('empty-steps')).toBeNull();
  });

  it('should not render steps when the array is empty', () => {
    render(<EmptyState title="Empty" steps={[]} />);
    expect(screen.queryByTestId('empty-steps')).toBeNull();
  });

  it('should render both links when both are provided', () => {
    render(
      <EmptyState
        title="Empty"
        docLabel="Docs"
        onDocClick={vi.fn()}
        tourLabel="Tour"
        onTourClick={vi.fn()}
      />,
    );
    expect(screen.getByTestId('empty-doc-link')).toBeDefined();
    expect(screen.getByTestId('empty-tour-link')).toBeDefined();
  });
});
