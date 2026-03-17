import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MotionProvider } from './MotionProvider';

describe('MotionProvider', () => {
  it('should render children', () => {
    render(
      <MotionProvider>
        <div data-testid="child">Hello</div>
      </MotionProvider>,
    );
    expect(screen.getByTestId('child')).toBeInTheDocument();
  });

  it('should render text content of children', () => {
    render(
      <MotionProvider>
        <span>Motion child text</span>
      </MotionProvider>,
    );
    expect(screen.getByText('Motion child text')).toBeInTheDocument();
  });
});
