import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Input } from './Input';

describe('Input', () => {
  it('should render a text input', () => {
    render(<Input placeholder="Type here" />);
    expect(screen.getByPlaceholderText('Type here')).toBeDefined();
  });

  it('should render a label when provided', () => {
    render(<Input label="Email" />);
    expect(screen.getByText('Email')).toBeDefined();
  });

  it('should associate label with input via htmlFor', () => {
    render(<Input label="Username" />);
    const label = screen.getByText('Username') as HTMLLabelElement;
    expect(label.htmlFor).toBe('username');
  });

  it('should display error message', () => {
    render(<Input error="Required field" />);
    expect(screen.getByText('Required field')).toBeDefined();
  });

  it('should apply error border class when error is set', () => {
    render(<Input error="Bad" data-testid="input" />);
    const input = screen.getByTestId('input');
    expect(input.className).toContain('border-[var(--vscode-errorForeground');
  });

  it('should display hint when no error', () => {
    render(<Input hint="Enter your email" />);
    expect(screen.getByText('Enter your email')).toBeDefined();
  });

  it('should hide hint when error is present', () => {
    render(<Input hint="Enter your email" error="Required" />);
    expect(screen.queryByText('Enter your email')).toBeNull();
    expect(screen.getByText('Required')).toBeDefined();
  });

  it('should call onChange handler', () => {
    const handler = vi.fn();
    render(<Input onChange={handler} data-testid="input" />);
    fireEvent.change(screen.getByTestId('input'), { target: { value: 'test' } });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('should forward ref', () => {
    let inputEl: HTMLInputElement | null = null;
    render(
      <Input
        ref={(el) => {
          inputEl = el;
        }}
      />,
    );
    expect(inputEl).toBeInstanceOf(HTMLInputElement);
  });
});
