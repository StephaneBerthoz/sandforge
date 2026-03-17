import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../../i18n';
import { AutopilotWizard } from './AutopilotWizard';

/** Mock useOrgStore to return test orgs. */
vi.mock('../../../stores/useOrgStore', () => ({
  useOrgStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      orgs: [
        {
          id: 'org-1',
          alias: 'DevSandbox',
          username: 'dev@test.com',
          instanceUrl: 'https://dev.salesforce.com',
          status: 'connected',
          orgType: 'sandbox',
          safetyTier: 'safe',
        },
        {
          id: 'org-2',
          alias: 'QASandbox',
          username: 'qa@test.com',
          instanceUrl: 'https://qa.salesforce.com',
          status: 'connected',
          orgType: 'sandbox',
          safetyTier: 'caution',
        },
      ],
    }),
}));

describe('AutopilotWizard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render without crashing', () => {
    render(<AutopilotWizard />);
    expect(screen.getByTestId('autopilot-wizard')).toBeDefined();
  });

  it('should show the wizard title', () => {
    render(<AutopilotWizard />);
    expect(screen.getByText('Autopilot Setup')).toBeDefined();
  });

  it('should show the step indicator', () => {
    render(<AutopilotWizard />);
    expect(screen.getByTestId('seed-step-indicator')).toBeDefined();
  });

  it('should render step 1 (Connect) by default', () => {
    render(<AutopilotWizard />);
    expect(screen.getByTestId('step1-connect')).toBeDefined();
  });

  it('should show next button', () => {
    render(<AutopilotWizard />);
    expect(screen.getByTestId('seed-wizard-next')).toBeDefined();
  });

  it('should show back button disabled on first step', () => {
    render(<AutopilotWizard />);
    expect(screen.getByTestId('seed-wizard-back')).toHaveProperty('disabled', true);
  });

  it('should disable next when no orgs are selected', () => {
    render(<AutopilotWizard />);
    expect(screen.getByTestId('seed-wizard-next')).toHaveProperty('disabled', true);
  });

  it('should advance to step 2 when both orgs selected and next clicked', () => {
    render(<AutopilotWizard />);

    // Select source org
    fireEvent.click(screen.getByTestId('source-org-org-1'));
    // Select target org
    fireEvent.click(screen.getByTestId('target-org-org-2'));

    // Next should be enabled now
    const nextBtn = screen.getByTestId('seed-wizard-next');
    expect(nextBtn).toHaveProperty('disabled', false);
    fireEvent.click(nextBtn);

    // Step 2 should be visible
    expect(screen.getByTestId('step2-objects')).toBeDefined();
  });

  it('should go back to step 1 from step 2', () => {
    render(<AutopilotWizard />);

    // Navigate to step 2
    fireEvent.click(screen.getByTestId('source-org-org-1'));
    fireEvent.click(screen.getByTestId('target-org-org-2'));
    fireEvent.click(screen.getByTestId('seed-wizard-next'));

    expect(screen.getByTestId('step2-objects')).toBeDefined();

    // Go back
    fireEvent.click(screen.getByTestId('seed-wizard-back'));
    expect(screen.getByTestId('step1-connect')).toBeDefined();
  });
});
