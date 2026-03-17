import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Stepper } from './Stepper';

const steps = ['Connect', 'Configure', 'Review', 'Execute'];

describe('Stepper', () => {
  it('should render all step labels', () => {
    render(<Stepper steps={steps} currentStep={0} />);
    for (const label of steps) {
      expect(screen.getByText(label)).toBeDefined();
    }
  });

  it('should highlight the active step', () => {
    render(<Stepper steps={steps} currentStep={1} />);
    const activeBtn = screen.getByLabelText('Step 2: Configure');
    expect(activeBtn.getAttribute('aria-current')).toBe('step');
  });

  it('should show checkmark for completed steps', () => {
    render(<Stepper steps={steps} currentStep={2} />);
    const completedBtn = screen.getByLabelText('Step 1: Connect');
    const svg = completedBtn.querySelector('svg');
    expect(svg).not.toBeNull();
  });

  it('should show step numbers for future steps', () => {
    render(<Stepper steps={steps} currentStep={0} />);
    const futureBtn = screen.getByLabelText('Step 3: Review');
    expect(futureBtn.textContent).toBe('3');
  });

  it('should call onStepClick when a step is clicked', () => {
    const handleClick = vi.fn();
    render(<Stepper steps={steps} currentStep={0} onStepClick={handleClick} />);
    fireEvent.click(screen.getByLabelText('Step 2: Configure'));
    expect(handleClick).toHaveBeenCalledWith(1);
  });

  it('should render connecting lines between steps', () => {
    const { container } = render(<Stepper steps={steps} currentStep={1} />);
    const lines = container.querySelectorAll('[aria-hidden="true"]');
    expect(lines.length).toBe(steps.length - 1);
  });

  it('should apply custom className', () => {
    const { container } = render(<Stepper steps={steps} currentStep={0} className="my-4" />);
    expect(container.firstElementChild?.className).toContain('my-4');
  });
});
