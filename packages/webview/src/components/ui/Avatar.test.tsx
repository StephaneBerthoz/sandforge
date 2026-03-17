import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Avatar } from './Avatar';

describe('Avatar', () => {
  it('should render initials from a full name', () => {
    render(<Avatar name="John Doe" />);
    expect(screen.getByText('JD')).toBeDefined();
  });

  it('should render single initial for a single-word name', () => {
    render(<Avatar name="Admin" />);
    expect(screen.getByText('A')).toBeDefined();
  });

  it('should render question mark when no name or src provided', () => {
    render(<Avatar />);
    expect(screen.getByText('?')).toBeDefined();
  });

  it('should render an image when src is provided', () => {
    render(<Avatar name="Jane" src="https://example.com/avatar.png" />);
    const img = screen.getByRole('img') as HTMLImageElement;
    expect(img.tagName).toBe('IMG');
    expect(img.getAttribute('src')).toBe('https://example.com/avatar.png');
  });

  it('should apply size classes correctly', () => {
    const { container: sm } = render(<Avatar name="A B" size="sm" />);
    expect(sm.firstElementChild?.className).toContain('w-6');

    const { container: lg } = render(<Avatar name="A B" size="lg" />);
    expect(lg.firstElementChild?.className).toContain('w-12');
  });

  it('should generate deterministic background color from name', () => {
    const { container: first } = render(<Avatar name="Test User" />);
    const { container: second } = render(<Avatar name="Test User" />);
    const firstClass = first.firstElementChild?.className;
    const secondClass = second.firstElementChild?.className;
    expect(firstClass).toBe(secondClass);
  });

  it('should apply custom className', () => {
    const { container } = render(<Avatar name="John" className="border-2" />);
    expect(container.firstElementChild?.className).toContain('border-2');
  });
});
