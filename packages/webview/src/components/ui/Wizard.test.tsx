import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { Wizard } from './Wizard';
import type { WizardStep } from './Wizard';

const steps: WizardStep[] = [
  { id: 'alpha', labelKey: 'seed.selectOrg', descriptionKey: 'seed.selectOrgDesc' },
  { id: 'beta', labelKey: 'seed.selectObjects' },
  { id: 'gamma', labelKey: 'seed.configureFields', descriptionKey: 'seed.configureFieldsDesc' },
];

describe('Wizard', () => {
  it('should render with default testIdPrefix "wizard"', () => {
    render(
      <Wizard steps={steps} currentStep={0} onStepChange={vi.fn()}>
        <div>Content</div>
      </Wizard>,
    );
    expect(screen.getByTestId('wizard-wizard')).toBeDefined();
    expect(screen.getByTestId('wizard-step-indicator')).toBeDefined();
    expect(screen.getByTestId('wizard-step-alpha')).toBeDefined();
    expect(screen.getByTestId('wizard-step-beta')).toBeDefined();
    expect(screen.getByTestId('wizard-step-gamma')).toBeDefined();
    expect(screen.getByTestId('wizard-step-content')).toBeDefined();
  });

  it('should render children content', () => {
    render(
      <Wizard steps={steps} currentStep={0} onStepChange={vi.fn()}>
        <div>My Wizard Content</div>
      </Wizard>,
    );
    expect(screen.getByText('My Wizard Content')).toBeDefined();
  });

  it('should call onStepChange when next is clicked', () => {
    const onStepChange = vi.fn();
    render(
      <Wizard steps={steps} currentStep={0} onStepChange={onStepChange}>
        <div>Content</div>
      </Wizard>,
    );
    fireEvent.click(screen.getByTestId('wizard-wizard-next'));
    expect(onStepChange).toHaveBeenCalledWith(1);
  });

  it('should call onStepChange when back is clicked', () => {
    const onStepChange = vi.fn();
    render(
      <Wizard steps={steps} currentStep={1} onStepChange={onStepChange}>
        <div>Content</div>
      </Wizard>,
    );
    fireEvent.click(screen.getByTestId('wizard-wizard-back'));
    expect(onStepChange).toHaveBeenCalledWith(0);
  });

  it('should disable back button on first step', () => {
    render(
      <Wizard steps={steps} currentStep={0} onStepChange={vi.fn()}>
        <div>Content</div>
      </Wizard>,
    );
    expect(screen.getByTestId('wizard-wizard-back')).toHaveProperty('disabled', true);
  });

  it('should show finish button on last step', () => {
    const onFinish = vi.fn();
    render(
      <Wizard steps={steps} currentStep={2} onStepChange={vi.fn()} onFinish={onFinish}>
        <div>Content</div>
      </Wizard>,
    );
    expect(screen.getByTestId('wizard-wizard-finish')).toBeDefined();
    fireEvent.click(screen.getByTestId('wizard-wizard-finish'));
    expect(onFinish).toHaveBeenCalled();
  });

  it('should show checkmark for completed steps', () => {
    render(
      <Wizard steps={steps} currentStep={2} onStepChange={vi.fn()}>
        <div>Content</div>
      </Wizard>,
    );
    expect(screen.getByTestId('wizard-check-alpha')).toBeDefined();
    expect(screen.getByTestId('wizard-check-beta')).toBeDefined();
  });

  it('should support custom testIdPrefix', () => {
    render(
      <Wizard steps={steps} currentStep={0} onStepChange={vi.fn()} testIdPrefix="custom">
        <div>Content</div>
      </Wizard>,
    );
    expect(screen.getByTestId('custom-wizard')).toBeDefined();
    expect(screen.getByTestId('custom-step-indicator')).toBeDefined();
    expect(screen.getByTestId('custom-step-alpha')).toBeDefined();
    expect(screen.getByTestId('custom-step-content')).toBeDefined();
    expect(screen.getByTestId('custom-wizard-next')).toBeDefined();
    expect(screen.getByTestId('custom-wizard-back')).toBeDefined();
  });

  it('should hide navigation when isFinished is true', () => {
    render(
      <Wizard steps={steps} currentStep={2} onStepChange={vi.fn()} isFinished>
        <div>Done</div>
      </Wizard>,
    );
    expect(screen.queryByTestId('wizard-wizard-next')).toBeNull();
    expect(screen.queryByTestId('wizard-wizard-finish')).toBeNull();
    expect(screen.queryByTestId('wizard-wizard-back')).toBeNull();
  });

  it('should disable next when canGoNext is false', () => {
    render(
      <Wizard steps={steps} currentStep={0} onStepChange={vi.fn()} canGoNext={false}>
        <div>Content</div>
      </Wizard>,
    );
    expect(screen.getByTestId('wizard-wizard-next')).toHaveProperty('disabled', true);
  });

  it('should allow clicking completed steps', () => {
    const onStepChange = vi.fn();
    render(
      <Wizard steps={steps} currentStep={2} onStepChange={onStepChange}>
        <div>Content</div>
      </Wizard>,
    );
    fireEvent.click(screen.getByTestId('wizard-step-alpha'));
    expect(onStepChange).toHaveBeenCalledWith(0);
  });

  it('should disable future steps', () => {
    render(
      <Wizard steps={steps} currentStep={0} onStepChange={vi.fn()}>
        <div>Content</div>
      </Wizard>,
    );
    expect(screen.getByTestId('wizard-step-gamma')).toHaveProperty('disabled', true);
  });

  it('should not render a cancel control when onCancel is omitted', () => {
    render(
      <Wizard steps={steps} currentStep={1} onStepChange={vi.fn()}>
        <div>Content</div>
      </Wizard>,
    );
    expect(screen.queryByTestId('wizard-wizard-cancel')).toBeNull();
  });

  it('should call onCancel when the cancel control is clicked', () => {
    const onCancel = vi.fn();
    render(
      <Wizard steps={steps} currentStep={1} onStepChange={vi.fn()} onCancel={onCancel}>
        <div>Content</div>
      </Wizard>,
    );
    fireEvent.click(screen.getByTestId('wizard-wizard-cancel'));
    expect(onCancel).toHaveBeenCalled();
  });

  it('should keep the cancel control usable while back and next are disabled', () => {
    const onCancel = vi.fn();
    render(
      <Wizard
        steps={steps}
        currentStep={0}
        onStepChange={vi.fn()}
        canGoNext={false}
        onCancel={onCancel}
      >
        <div>Content</div>
      </Wizard>,
    );
    expect(screen.getByTestId('wizard-wizard-back')).toHaveProperty('disabled', true);
    expect(screen.getByTestId('wizard-wizard-next')).toHaveProperty('disabled', true);
    expect(screen.getByTestId('wizard-wizard-cancel')).toHaveProperty('disabled', false);
  });

  it('should label the cancel control from cancelLabelKey', () => {
    render(
      <Wizard
        steps={steps}
        currentStep={1}
        onStepChange={vi.fn()}
        onCancel={vi.fn()}
        cancelLabelKey="common.cancelRun"
      >
        <div>Content</div>
      </Wizard>,
    );
    expect(screen.getByTestId('wizard-wizard-cancel').textContent).toBe('Cancel run');
  });

  it('should hide the cancel control once the wizard is finished', () => {
    render(
      <Wizard steps={steps} currentStep={2} onStepChange={vi.fn()} onCancel={vi.fn()} isFinished>
        <div>Done</div>
      </Wizard>,
    );
    expect(screen.queryByTestId('wizard-wizard-cancel')).toBeNull();
  });

  it('should show description when descriptionKey is provided', () => {
    render(
      <Wizard steps={steps} currentStep={0} onStepChange={vi.fn()}>
        <div>Content</div>
      </Wizard>,
    );
    // step alpha has descriptionKey, step beta does not
    const alphaButton = screen.getByTestId('wizard-step-alpha');
    expect(alphaButton.querySelectorAll('span').length).toBeGreaterThan(2);
  });
});
