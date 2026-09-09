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

/**
 * A <select> takes no accessible name from its placeholder <option>, and the
 * old label-derived id collided whenever two selects shared a label — both
 * failures are invisible to a fixture that renders a single labelled select.
 */
describe('Select accessible name', () => {
  it('associates the visible label with the select', () => {
    render(<Select label="Choose one" options={options} />);
    expect(screen.getByLabelText('Choose one').tagName).toBe('SELECT');
  });

  it('gives two selects sharing a label distinct ids', () => {
    render(
      <>
        <Select label="Choose one" options={options} />
        <Select label="Choose one" options={options} />
      </>,
    );
    const ids = screen.getAllByRole('combobox').map((el) => el.id);
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids.every((id) => id.length > 0)).toBe(true);
  });

  it('points each duplicated label at its own select', () => {
    const { container } = render(
      <>
        <Select label="Choose one" options={options} />
        <Select label="Choose one" options={options} />
      </>,
    );
    const labels = Array.from(container.querySelectorAll('label'));
    const selects = screen.getAllByRole('combobox');
    expect(labels).toHaveLength(2);
    // Resolved through the document, not compared attribute-to-attribute: with a
    // shared id both `for` attributes still matched, yet both resolved to the
    // first select and the second one was left nameless.
    expect(document.getElementById(labels[0]?.getAttribute('for') ?? '')).toBe(selects[0]);
    expect(document.getElementById(labels[1]?.getAttribute('for') ?? '')).toBe(selects[1]);
  });

  it('names an unlabelled select from its placeholder', () => {
    render(<Select options={options} placeholder="Pick..." />);
    expect(screen.getByRole('combobox').getAttribute('aria-label')).toBe('Pick...');
    expect(screen.getByLabelText('Pick...').tagName).toBe('SELECT');
  });

  it('lets an explicit aria-label win over the placeholder', () => {
    render(<Select options={options} placeholder="Pick..." aria-label="Operation" />);
    expect(screen.getByRole('combobox').getAttribute('aria-label')).toBe('Operation');
  });

  it('does not shadow a visible label with the placeholder', () => {
    render(<Select label="Choose one" options={options} placeholder="Pick..." />);
    expect(screen.getByRole('combobox').getAttribute('aria-label')).toBeNull();
  });

  it('does not shadow an aria-labelledby reference with the placeholder', () => {
    render(
      <>
        <span id="ext-label">External label</span>
        <Select options={options} placeholder="Pick..." aria-labelledby="ext-label" />
      </>,
    );
    const selectEl = screen.getByRole('combobox');
    expect(selectEl.getAttribute('aria-label')).toBeNull();
    expect(selectEl.getAttribute('aria-labelledby')).toBe('ext-label');
  });
});
