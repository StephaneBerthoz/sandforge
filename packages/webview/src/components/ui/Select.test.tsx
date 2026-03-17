import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Select } from './Select';

const options = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
  { value: 'c', label: 'Gamma', disabled: true },
];

describe('Select', () => {
  it('should render all options', () => {
    render(<Select options={options} />);
    const selectEl = screen.getByRole('combobox') as HTMLSelectElement;
    expect(selectEl.options.length).toBe(3);
  });

  it('should render label when provided', () => {
    render(<Select label="Choose one" options={options} />);
    expect(screen.getByText('Choose one')).toBeDefined();
  });

  it('should render placeholder as disabled option', () => {
    render(<Select options={options} placeholder="Pick..." />);
    const selectEl = screen.getByRole('combobox') as HTMLSelectElement;
    const first = selectEl.options[0] as HTMLOptionElement;
    expect(first.textContent).toBe('Pick...');
    expect(first.disabled).toBe(true);
  });

  it('should display error message', () => {
    render(<Select options={options} error="Required" />);
    expect(screen.getByText('Required')).toBeDefined();
  });

  it('should disable individual options', () => {
    render(<Select options={options} />);
    const selectEl = screen.getByRole('combobox') as HTMLSelectElement;
    const gammaOption = Array.from(selectEl.options).find((o) => o.value === 'c');
    expect(gammaOption?.disabled).toBe(true);
  });

  it('should call onChange when selection changes', () => {
    const handler = vi.fn();
    render(<Select options={options} onChange={handler} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'b' } });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('should merge custom className', () => {
    render(<Select options={options} className="w-64" />);
    const selectEl = screen.getByRole('combobox');
    expect(selectEl.className).toContain('w-64');
  });
});
