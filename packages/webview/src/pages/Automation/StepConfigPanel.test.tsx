import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { OrgSafetyTier } from '@sandforge/shared';
import type { PipelineStep, SalesforceOrg } from '@sandforge/shared';
import { useOrgStore } from '../../stores/useOrgStore';
import { StepConfigPanel } from './StepConfigPanel';

/** A connected org, as the org store holds one. */
function org(id: string, alias: string): SalesforceOrg {
  return {
    id,
    alias,
    username: `${alias}@example.com`,
    instanceUrl: 'https://example.my.salesforce.com',
    orgId: '00D000000000001AAA',
    orgType: 'Sandbox',
    authMethod: 'oauth_web',
    safetyTier: OrgSafetyTier.LOW,
    appearance: { color: '#0070d2', icon: 'cloud', position: 0 },
    metadata: { apiVersion: '62.0', edition: 'Developer Edition', features: [] },
    status: 'connected',
    lastConnected: '2026-09-01T00:00:00Z',
    tags: [],
  };
}

const step: PipelineStep = {
  id: 'step-1',
  name: 'Seed Accounts',
  type: 'seed',
  config: { objectName: 'Account', recordCount: 100 },
  continueOnError: false,
  timeout: 300,
  retries: 2,
};

describe('StepConfigPanel', () => {
  it('should show empty state when no step', () => {
    render(<StepConfigPanel />);
    expect(screen.getByTestId('step-config-empty')).toBeDefined();
  });

  it('should render panel with step', () => {
    render(<StepConfigPanel step={step} />);
    expect(screen.getByTestId('step-config-panel')).toBeDefined();
  });

  it('should show step name input', () => {
    render(<StepConfigPanel step={step} onUpdate={vi.fn()} />);
    const input = screen.getByTestId('step-name-input') as HTMLInputElement;
    expect(input.value).toBe('Seed Accounts');
  });

  it('should call onUpdate when name changes', () => {
    const onUpdate = vi.fn();
    render(<StepConfigPanel step={step} onUpdate={onUpdate} />);
    fireEvent.change(screen.getByTestId('step-name-input'), { target: { value: 'New Name' } });
    expect(onUpdate).toHaveBeenCalledWith('step-1', { name: 'New Name' });
  });

  it('should show timeout input', () => {
    render(<StepConfigPanel step={step} onUpdate={vi.fn()} />);
    const input = screen.getByTestId('step-timeout-input') as HTMLInputElement;
    expect(input.value).toBe('300');
  });

  it('should show retries input', () => {
    render(<StepConfigPanel step={step} onUpdate={vi.fn()} />);
    const input = screen.getByTestId('step-retries-input') as HTMLInputElement;
    expect(input.value).toBe('2');
  });

  it('should show continue on error checkbox', () => {
    render(<StepConfigPanel step={step} onUpdate={vi.fn()} />);
    const checkbox = screen.getByTestId('step-continue-error') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
  });

  it('should call onUpdate when continueOnError toggled', () => {
    const onUpdate = vi.fn();
    render(<StepConfigPanel step={step} onUpdate={onUpdate} />);
    fireEvent.click(screen.getByTestId('step-continue-error'));
    expect(onUpdate).toHaveBeenCalledWith('step-1', { continueOnError: true });
  });

  it('should show type-specific config for seed step', () => {
    render(<StepConfigPanel step={step} onUpdate={vi.fn()} />);
    expect(screen.getByTestId('step-type-config')).toBeDefined();
    const objectInput = screen.getByTestId('config-objectName') as HTMLInputElement;
    expect(objectInput.value).toBe('Account');
  });

  it('should call onUpdate for config field changes', () => {
    const onUpdate = vi.fn();
    render(<StepConfigPanel step={step} onUpdate={onUpdate} />);
    fireEvent.change(screen.getByTestId('config-objectName'), { target: { value: 'Contact' } });
    expect(onUpdate).toHaveBeenCalledWith('step-1', {
      config: { objectName: 'Contact', recordCount: 100 },
    });
  });

  it('should show boolean config field as checkbox for delete step', () => {
    const deleteStep: PipelineStep = {
      id: 'step-d',
      name: 'Delete',
      type: 'delete',
      config: { hardDelete: true },
      continueOnError: false,
    };
    render(<StepConfigPanel step={deleteStep} onUpdate={vi.fn()} />);
    const checkbox = screen.getByTestId('config-hardDelete') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
  });

  it('asks a notification step for its text and not for a channel', () => {
    // A notification is shown in VS Code, to whoever runs the pipeline: a
    // channel box would collect an address that no code reads.
    const notificationStep: PipelineStep = {
      id: 'step-n',
      name: 'Notify',
      type: 'notification',
      config: { message: 'Refresh done' },
      continueOnError: false,
    };
    render(<StepConfigPanel step={notificationStep} onUpdate={vi.fn()} />);
    expect(screen.getByTestId('config-message')).toBeDefined();
    expect(screen.queryByTestId('config-channel')).toBeNull();
  });

  it('caps a notification message at the length the extension shows', () => {
    const notificationStep: PipelineStep = {
      id: 'step-n',
      name: 'Notify',
      type: 'notification',
      config: {},
      continueOnError: false,
    };
    render(<StepConfigPanel step={notificationStep} onUpdate={vi.fn()} />);
    expect(screen.getByTestId('config-message').getAttribute('maxlength')).toBe('500');
  });

  it('offers no timeout past what a timer holds', () => {
    render(<StepConfigPanel step={step} onUpdate={vi.fn()} />);
    expect(screen.getByTestId('step-timeout-input').getAttribute('max')).toBe(
      String(24 * 24 * 60 * 60 * 1000),
    );
  });

  it('should show step type badge', () => {
    render(<StepConfigPanel step={step} />);
    expect(screen.getByTestId('step-config-panel').textContent).toContain('seed');
  });
});

describe('StepConfigPanel — the steps that run a module', () => {
  beforeEach(() => {
    useOrgStore.setState({ orgs: [org('org-a', 'uat'), org('org-b', 'dev')] });
  });

  it('offers a scratch org to a step as one, not as a sandbox', () => {
    // The step panel borrowed Compare's label, which called every org but a
    // production one [SBX].
    useOrgStore.setState({
      orgs: [org('org-a', 'uat'), { ...org('org-c', 'feature'), orgType: 'Scratch' }],
    });
    const backup: PipelineStep = {
      id: 'step-s',
      name: 'Snapshot',
      type: 'backup',
      config: {},
      continueOnError: false,
    };
    render(<StepConfigPanel step={backup} onUpdate={vi.fn()} />);

    const orgSelect = screen.getByTestId('config-orgId') as HTMLSelectElement;
    expect([...orgSelect.options].map((option) => option.textContent)).toContain(
      'feature [SCRATCH]',
    );
  });

  it('asks a Backup step for the org and objects DataOps backs up', () => {
    const backup: PipelineStep = {
      id: 'step-b',
      name: 'Snapshot',
      type: 'backup',
      config: {},
      continueOnError: false,
    };
    const onUpdate = vi.fn();
    render(<StepConfigPanel step={backup} onUpdate={onUpdate} />);

    const orgSelect = screen.getByTestId('config-orgId') as HTMLSelectElement;
    expect([...orgSelect.options].map((option) => option.textContent)).toEqual([
      'Select Org',
      'uat [SANDBOX]',
      'dev [SANDBOX]',
    ]);
    fireEvent.change(orgSelect, { target: { value: 'org-b' } });
    expect(onUpdate).toHaveBeenLastCalledWith('step-b', { config: { orgId: 'org-b' } });

    // The text stays as typed, trailing comma included; the names go to the step.
    const objects = screen.getByTestId('config-objects') as HTMLInputElement;
    fireEvent.change(objects, { target: { value: 'Account, ' } });
    expect(objects.value).toBe('Account, ');
    expect(onUpdate).toHaveBeenLastCalledWith('step-b', { config: { objects: ['Account'] } });
    fireEvent.change(objects, { target: { value: 'Account, Contact' } });
    expect(onUpdate).toHaveBeenLastCalledWith('step-b', {
      config: { objects: ['Account', 'Contact'] },
    });
  });

  it('asks a Pre-check for the Monitor signals it reads, and drops a check it cannot run', () => {
    const precheck: PipelineStep = {
      id: 'step-p',
      name: 'Check',
      type: 'precheck',
      // What a Marketplace template names: a check the extension does not have.
      config: { orgId: 'org-a', checks: ['rowCount', 'storage'] },
      continueOnError: false,
    };
    const onUpdate = vi.fn();
    render(<StepConfigPanel step={precheck} onUpdate={onUpdate} />);

    expect((screen.getByTestId('config-check-storage') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByTestId('config-check-apiLimits'));
    expect(onUpdate).toHaveBeenLastCalledWith('step-p', {
      config: { orgId: 'org-a', checks: ['storage', 'apiLimits'] },
    });
  });

  it('asks a Compare step for two orgs and the metadata types, with the Compare page controls', () => {
    const compare: PipelineStep = {
      id: 'step-c',
      name: 'Diff',
      type: 'compare',
      config: { sourceOrgId: 'org-a', targetOrgId: 'org-a' },
      continueOnError: false,
    };
    const onUpdate = vi.fn();
    render(<StepConfigPanel step={compare} onUpdate={onUpdate} />);

    expect(screen.getByTestId('config-same-org').textContent).toBe(
      'Source and target orgs must be different',
    );
    fireEvent.change(screen.getByTestId('config-targetOrgId'), { target: { value: 'org-b' } });
    expect(onUpdate).toHaveBeenLastCalledWith('step-c', {
      config: { sourceOrgId: 'org-a', targetOrgId: 'org-b' },
    });
    fireEvent.click(screen.getByTestId('cat-ApexClass'));
    expect(onUpdate).toHaveBeenLastCalledWith('step-c', {
      config: { sourceOrgId: 'org-a', targetOrgId: 'org-a', types: ['ApexClass'] },
    });
  });
});
