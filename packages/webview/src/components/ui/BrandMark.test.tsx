import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrandMark } from './BrandMark';

describe('BrandMark', () => {
  it('draws the sandbox and the fire rising out of it, as the Marketplace icon does', () => {
    render(<BrandMark />);
    const mark = screen.getByTestId('brand-mark');

    // The box's two front faces, and the flame with its core.
    const fills = [...mark.querySelectorAll('path')].map((p) => p.getAttribute('fill'));
    expect(fills).toEqual(['#262A3D', '#F5A623', '#FFD27A', '#646E8C', '#8F99B6', 'none']);
  });

  it('is decorative: the name beside it is what a screen reader reads', () => {
    render(<BrandMark />);
    const mark = screen.getByTestId('brand-mark');

    expect(mark.getAttribute('aria-hidden')).toBe('true');
    expect(mark.getAttribute('focusable')).toBe('false');
  });

  it('takes the size its classes give it', () => {
    render(<BrandMark className="w-5 h-5" />);

    expect(screen.getByTestId('brand-mark').getAttribute('class')).toContain('w-5 h-5');
  });
});
