import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Badge } from './Badge';

describe('Badge', () => {
  it('should render children text', () => {
    render(<Badge>3</Badge>);
    expect(screen.getByText('3')).toBeDefined();
  });

  it('should apply default variant classes', () => {
    render(<Badge>New</Badge>);
    expect(screen.getByText('New').className).toContain('bg-[var(--vscode-badge-background');
  });

  it('should apply success variant', () => {
    render(<Badge variant="success">OK</Badge>);
    expect(screen.getByText('OK').className).toContain('bg-emerald-700');
  });

  it('should apply warning variant', () => {
    render(<Badge variant="warning">!</Badge>);
    expect(screen.getByText('!').className).toContain('bg-amber-700');
  });

  it('should apply error variant', () => {
    render(<Badge variant="error">Err</Badge>);
    expect(screen.getByText('Err').className).toContain('bg-red-700');
  });

  it('should apply info variant', () => {
    render(<Badge variant="info">i</Badge>);
    expect(screen.getByText('i').className).toContain('bg-blue-700');
  });

  it('should merge custom className', () => {
    render(<Badge className="ml-2">X</Badge>);
    expect(screen.getByText('X').className).toContain('ml-2');
  });
});
