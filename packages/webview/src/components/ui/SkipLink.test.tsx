import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SkipLink } from './SkipLink';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string) => fallback,
  }),
}));

describe('SkipLink', () => {
  it('should render with default text', () => {
    render(<SkipLink />);
    const link = screen.getByText('Skip to main content');
    expect(link).toBeDefined();
    expect(link.tagName).toBe('A');
  });

  it('should have the sr-only class by default', () => {
    render(<SkipLink />);
    const link = screen.getByText('Skip to main content');
    expect(link.className).toContain('sr-only');
  });

  it('should link to the target ID', () => {
    render(<SkipLink targetId="my-content" />);
    const link = screen.getByText('Skip to main content');
    expect(link.getAttribute('href')).toBe('#my-content');
  });

  it('should use default targetId of main-content', () => {
    render(<SkipLink />);
    const link = screen.getByText('Skip to main content');
    expect(link.getAttribute('href')).toBe('#main-content');
  });

  it('should focus and scroll target on click', () => {
    const mockElement = document.createElement('div');
    mockElement.id = 'main-content';
    mockElement.focus = vi.fn();
    mockElement.scrollIntoView = vi.fn();
    document.body.appendChild(mockElement);

    render(<SkipLink />);
    const link = screen.getByText('Skip to main content');
    fireEvent.click(link);

    expect(mockElement.focus).toHaveBeenCalled();
    expect(mockElement.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth' });

    document.body.removeChild(mockElement);
  });

  it('should accept custom className', () => {
    render(<SkipLink className="my-custom-class" />);
    const link = screen.getByText('Skip to main content');
    expect(link.className).toBe('my-custom-class');
  });
});
