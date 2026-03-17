import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Logo } from './Logo';

describe('Logo', () => {
  it('should render an SVG element', () => {
    render(<Logo />);
    const svg = screen.getByTestId('logo-svg');
    expect(svg).toBeDefined();
    expect(svg.tagName).toBe('svg');
  });

  it('should have role img and aria-label', () => {
    render(<Logo />);
    const svg = screen.getByRole('img');
    expect(svg.getAttribute('aria-label')).toBe('SandForge logo');
  });

  it('should render at small size (24px)', () => {
    render(<Logo size="small" />);
    const svg = screen.getByTestId('logo-svg');
    expect(svg.getAttribute('width')).toBe('24');
    expect(svg.getAttribute('height')).toBe('24');
  });

  it('should render at medium size (48px) by default', () => {
    render(<Logo />);
    const svg = screen.getByTestId('logo-svg');
    expect(svg.getAttribute('width')).toBe('48');
    expect(svg.getAttribute('height')).toBe('48');
  });

  it('should render at large size (96px)', () => {
    render(<Logo size="large" />);
    const svg = screen.getByTestId('logo-svg');
    expect(svg.getAttribute('width')).toBe('96');
    expect(svg.getAttribute('height')).toBe('96');
  });

  it('should apply mono color via currentColor when mono prop is set', () => {
    const { container } = render(<Logo mono />);
    const paths = container.querySelectorAll('path');
    const usesCurrentColor = Array.from(paths).some(
      (p) => p.getAttribute('fill') === 'currentColor',
    );
    expect(usesCurrentColor).toBe(true);
  });

  it('should use colored fills when mono is false', () => {
    const { container } = render(<Logo />);
    const paths = container.querySelectorAll('path');
    const usesCurrentColor = Array.from(paths).some(
      (p) => p.getAttribute('fill') === 'currentColor',
    );
    expect(usesCurrentColor).toBe(false);
  });

  it('should accept custom className', () => {
    render(<Logo className="my-logo" />);
    const svg = screen.getByTestId('logo-svg');
    expect(svg.getAttribute('class')).toBe('my-logo');
  });

  it('should contain animation keyframes in style element', () => {
    const { container } = render(<Logo />);
    const style = container.querySelector('style');
    expect(style).toBeDefined();
    expect(style?.textContent).toContain('sfSparkDrift');
    expect(style?.textContent).toContain('prefers-reduced-motion');
  });
});
