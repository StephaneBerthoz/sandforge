import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Spinner } from './Spinner';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

describe('Spinner', () => {
  it('should render with default size', () => {
    render(<Spinner />);
    expect(screen.getByTestId('spinner')).toBeDefined();
    expect(screen.getByRole('status')).toBeDefined();
  });

  it('should render with label', () => {
    render(<Spinner label="Loading data..." />);
    expect(screen.getByText('Loading data...')).toBeDefined();
  });

  it('should render without label when not provided', () => {
    const { container } = render(<Spinner />);
    expect(container.querySelector('span')).toBeNull();
  });

  it('should accept size prop', () => {
    render(<Spinner size="lg" label="Big spinner" />);
    expect(screen.getByRole('status')).toBeDefined();
  });

  it('should have aria-live="polite" on the wrapper', () => {
    render(<Spinner />);
    const wrapper = screen.getByTestId('spinner');
    expect(wrapper.getAttribute('aria-live')).toBe('polite');
  });

  it('should have role="status" with aria-label on the spinning element', () => {
    render(<Spinner />);
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-label')).toBe('Loading...');
  });

  it('should use provided label as aria-label', () => {
    render(<Spinner label="Saving data..." />);
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-label')).toBe('Saving data...');
  });
});
