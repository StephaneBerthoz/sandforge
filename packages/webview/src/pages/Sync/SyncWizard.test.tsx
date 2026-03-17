import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { SyncWizard } from './SyncWizard';
import type { SyncWizardStep } from './SyncWizard';

const steps: SyncWizardStep[] = [
  { id: 'orgs', labelKey: 'sync.selectOrgs' },
  { id: 'objects', labelKey: 'sync.configureObjects' },
  { id: 'mapping', labelKey: 'sync.fieldMapping' },
];

describe('SyncWizard', () => {
  it('should render wizard container', () => {
    render(
      <SyncWizard steps={steps} currentStep={0} onStepChange={vi.fn()}>
        <div>Content</div>
      </SyncWizard>,
    );
    expect(screen.getByTestId('sync-wizard')).toBeDefined();
  });

  it('should render step indicators', () => {
    render(
      <SyncWizard steps={steps} currentStep={0} onStepChange={vi.fn()}>
        <div>Content</div>
      </SyncWizard>,
    );
    expect(screen.getByTestId('sync-step-indicator')).toBeDefined();
    expect(screen.getByTestId('sync-step-orgs')).toBeDefined();
  });

  it('should call onStepChange on next', () => {
    const onStepChange = vi.fn();
    render(
      <SyncWizard steps={steps} currentStep={0} onStepChange={onStepChange}>
        <div>Content</div>
      </SyncWizard>,
    );
    fireEvent.click(screen.getByTestId('sync-wizard-next'));
    expect(onStepChange).toHaveBeenCalledWith(1);
  });

  it('should call onStepChange on back', () => {
    const onStepChange = vi.fn();
    render(
      <SyncWizard steps={steps} currentStep={1} onStepChange={onStepChange}>
        <div>Content</div>
      </SyncWizard>,
    );
    fireEvent.click(screen.getByTestId('sync-wizard-back'));
    expect(onStepChange).toHaveBeenCalledWith(0);
  });

  it('should disable back on first step', () => {
    render(
      <SyncWizard steps={steps} currentStep={0} onStepChange={vi.fn()}>
        <div>Content</div>
      </SyncWizard>,
    );
    expect(screen.getByTestId('sync-wizard-back')).toHaveProperty('disabled', true);
  });

  it('should show finish on last step', () => {
    const onFinish = vi.fn();
    render(
      <SyncWizard steps={steps} currentStep={2} onStepChange={vi.fn()} onFinish={onFinish}>
        <div>Content</div>
      </SyncWizard>,
    );
    expect(screen.getByTestId('sync-wizard-finish')).toBeDefined();
    fireEvent.click(screen.getByTestId('sync-wizard-finish'));
    expect(onFinish).toHaveBeenCalled();
  });

  it('should hide navigation when finished', () => {
    render(
      <SyncWizard steps={steps} currentStep={2} onStepChange={vi.fn()} isFinished>
        <div>Done</div>
      </SyncWizard>,
    );
    expect(screen.queryByTestId('sync-wizard-next')).toBeNull();
    expect(screen.queryByTestId('sync-wizard-back')).toBeNull();
  });

  it('should render children', () => {
    render(
      <SyncWizard steps={steps} currentStep={0} onStepChange={vi.fn()}>
        <div>Step Content</div>
      </SyncWizard>,
    );
    expect(screen.getByText('Step Content')).toBeDefined();
  });
});
