import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { SeedWizard } from './SeedWizard';
import type { WizardStep } from './SeedWizard';

const steps: WizardStep[] = [
  { id: 'step1', labelKey: 'seed.selectOrg', descriptionKey: 'seed.selectOrgDesc' },
  { id: 'step2', labelKey: 'seed.selectObjects', descriptionKey: 'seed.selectObjectsDesc' },
  { id: 'step3', labelKey: 'seed.configureFields', descriptionKey: 'seed.configureFieldsDesc' },
];

describe('SeedWizard', () => {
  it('should render wizard container', () => {
    render(
      <SeedWizard steps={steps} currentStep={0} onStepChange={vi.fn()}>
        <div>Content</div>
      </SeedWizard>,
    );
    expect(screen.getByTestId('seed-wizard')).toBeDefined();
  });

  it('should render step indicators', () => {
    render(
      <SeedWizard steps={steps} currentStep={0} onStepChange={vi.fn()}>
        <div>Content</div>
      </SeedWizard>,
    );
    expect(screen.getByTestId('seed-step-indicator')).toBeDefined();
    expect(screen.getByTestId('seed-step-step1')).toBeDefined();
    expect(screen.getByTestId('seed-step-step2')).toBeDefined();
    expect(screen.getByTestId('seed-step-step3')).toBeDefined();
  });

  it('should render children content', () => {
    render(
      <SeedWizard steps={steps} currentStep={0} onStepChange={vi.fn()}>
        <div>My Step Content</div>
      </SeedWizard>,
    );
    expect(screen.getByText('My Step Content')).toBeDefined();
  });

  it('should call onStepChange when next is clicked', () => {
    const onStepChange = vi.fn();
    render(
      <SeedWizard steps={steps} currentStep={0} onStepChange={onStepChange}>
        <div>Content</div>
      </SeedWizard>,
    );
    fireEvent.click(screen.getByTestId('seed-wizard-next'));
    expect(onStepChange).toHaveBeenCalledWith(1);
  });

  it('should call onStepChange when back is clicked', () => {
    const onStepChange = vi.fn();
    render(
      <SeedWizard steps={steps} currentStep={1} onStepChange={onStepChange}>
        <div>Content</div>
      </SeedWizard>,
    );
    fireEvent.click(screen.getByTestId('seed-wizard-back'));
    expect(onStepChange).toHaveBeenCalledWith(0);
  });

  it('should disable back button on first step', () => {
    render(
      <SeedWizard steps={steps} currentStep={0} onStepChange={vi.fn()}>
        <div>Content</div>
      </SeedWizard>,
    );
    expect(screen.getByTestId('seed-wizard-back')).toHaveProperty('disabled', true);
  });

  it('should show finish button on last step', () => {
    const onFinish = vi.fn();
    render(
      <SeedWizard steps={steps} currentStep={2} onStepChange={vi.fn()} onFinish={onFinish}>
        <div>Content</div>
      </SeedWizard>,
    );
    expect(screen.getByTestId('seed-wizard-finish')).toBeDefined();
    fireEvent.click(screen.getByTestId('seed-wizard-finish'));
    expect(onFinish).toHaveBeenCalled();
  });

  it('should disable next when canGoNext is false', () => {
    render(
      <SeedWizard steps={steps} currentStep={0} onStepChange={vi.fn()} canGoNext={false}>
        <div>Content</div>
      </SeedWizard>,
    );
    expect(screen.getByTestId('seed-wizard-next')).toHaveProperty('disabled', true);
  });

  it('should hide navigation when isFinished is true', () => {
    render(
      <SeedWizard steps={steps} currentStep={2} onStepChange={vi.fn()} isFinished>
        <div>Done</div>
      </SeedWizard>,
    );
    expect(screen.queryByTestId('seed-wizard-next')).toBeNull();
    expect(screen.queryByTestId('seed-wizard-finish')).toBeNull();
    expect(screen.queryByTestId('seed-wizard-back')).toBeNull();
  });

  it('should allow clicking completed steps', () => {
    const onStepChange = vi.fn();
    render(
      <SeedWizard steps={steps} currentStep={2} onStepChange={onStepChange}>
        <div>Content</div>
      </SeedWizard>,
    );
    fireEvent.click(screen.getByTestId('seed-step-step1'));
    expect(onStepChange).toHaveBeenCalledWith(0);
  });
});
