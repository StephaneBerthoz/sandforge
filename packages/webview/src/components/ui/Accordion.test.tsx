import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Accordion } from './Accordion';
import type { AccordionItem } from './Accordion';

const items: AccordionItem[] = [
  { title: 'Section 1', content: 'Content 1' },
  { title: 'Section 2', content: 'Content 2', defaultOpen: true },
  { title: 'Section 3', content: 'Content 3' },
];

describe('Accordion', () => {
  it('should render all section titles', () => {
    render(<Accordion items={items} />);
    for (const item of items) {
      expect(screen.getByText(item.title)).toBeDefined();
    }
  });

  it('should open defaultOpen items initially', () => {
    render(<Accordion items={items} />);
    const section2Button = screen.getByText('Section 2');
    expect(section2Button.closest('button')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('should toggle section on click', () => {
    render(<Accordion items={items} />);
    const button = screen.getByText('Section 1').closest('button')!;
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('should allow multiple sections open by default', () => {
    render(<Accordion items={items} />);
    const btn1 = screen.getByText('Section 1').closest('button')!;
    const btn2 = screen.getByText('Section 2').closest('button')!;
    fireEvent.click(btn1);
    expect(btn1.getAttribute('aria-expanded')).toBe('true');
    expect(btn2.getAttribute('aria-expanded')).toBe('true');
  });

  it('should only allow one section open in single mode', () => {
    render(<Accordion items={items} single />);
    const btn1 = screen.getByText('Section 1').closest('button')!;
    const btn2 = screen.getByText('Section 2').closest('button')!;
    fireEvent.click(btn1);
    expect(btn1.getAttribute('aria-expanded')).toBe('true');
    expect(btn2.getAttribute('aria-expanded')).toBe('false');
  });

  it('should have correct aria-controls linking', () => {
    render(<Accordion items={items} />);
    const button = screen.getByText('Section 1').closest('button')!;
    const panelId = button.getAttribute('aria-controls');
    expect(panelId).toBe('accordion-panel-0');
  });

  it('should apply custom className', () => {
    const { container } = render(<Accordion items={items} className="mt-4" />);
    expect(container.firstElementChild?.className).toContain('mt-4');
  });
});
