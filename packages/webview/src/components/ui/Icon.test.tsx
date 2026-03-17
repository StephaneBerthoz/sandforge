import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Icon } from './Icon';

describe('Icon', () => {
  it('should render with the correct codicon class', () => {
    render(<Icon name="dashboard" />);
    const icon = screen.getByTestId('icon-dashboard');
    expect(icon.classList.contains('codicon')).toBe(true);
    expect(icon.classList.contains('codicon-dashboard')).toBe(true);
  });

  it('should be aria-hidden when no label is provided', () => {
    render(<Icon name="sync" />);
    const icon = screen.getByTestId('icon-sync');
    expect(icon.getAttribute('aria-hidden')).toBe('true');
  });

  it('should have role="img" and aria-label when label is provided', () => {
    render(<Icon name="error" label="Error icon" />);
    const icon = screen.getByTestId('icon-error');
    expect(icon.getAttribute('role')).toBe('img');
    expect(icon.getAttribute('aria-label')).toBe('Error icon');
  });

  it('should apply spin class when spin prop is true', () => {
    render(<Icon name="loading" spin />);
    const icon = screen.getByTestId('icon-loading');
    expect(icon.classList.contains('sf-spin')).toBe(true);
  });

  it('should merge custom className', () => {
    render(<Icon name="gear" className="text-lg" />);
    const icon = screen.getByTestId('icon-gear');
    expect(icon.classList.contains('text-lg')).toBe(true);
  });
});
