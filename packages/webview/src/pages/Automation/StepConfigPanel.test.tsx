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
  config: { orgId: 'org-1', templateId: 'tpl-saved' },
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

  it('asks a Seed step for its org and a template the extension described, the shipped ones in the page’s words', () => {
    render(
      <StepConfigPanel
        step={step}
        onUpdate={vi.fn()}
        seedTemplates={[
          { id: 'tpl-saved', name: 'Saved', builtIn: false, valid: true, usesAi: false },
          {
            id: 'prebuilt-minimal-demo',
            name: 'seed.templates.minimalDemo.name',
            builtIn: true,
            valid: true,
            usesAi: false,
          },
        ]}
      />,
    );
    expect(screen.getByTestId('step-type-config')).toBeDefined();
    const select = screen.getByTestId('config-seed-templateId') as HTMLSelectElement;
    expect(select.value).toBe('tpl-saved');
    const labels = [...select.options].map((option) => option.textContent);
    expect(labels).toContain('Saved');
    expect(labels).not.toContain('seed.templates.minimalDemo.name');
    expect(screen.getByTestId('config-seed-note').textContent).toContain('Recent runs');
  });

  it('keeps a template no longer there chosen, and writes the template picked', () => {
    const onUpdate = vi.fn();
    render(<StepConfigPanel step={step} onUpdate={onUpdate} seedTemplates={[]} />);
    const select = screen.getByTestId('config-seed-templateId') as HTMLSelectElement;
    expect(select.selectedOptions[0]?.textContent).toBe('A template that is no longer saved');
    fireEvent.change(select, { target: { value: '' } });
    expect(onUpdate).toHaveBeenCalledWith('step-1', {
      config: { orgId: 'org-1', templateId: '' },
    });
  });

  it('asks an Anonymize step for a template, one of its objects, and a condition once an object is chosen', () => {
    const onUpdate = vi.fn();
    const anonymize: PipelineStep = {
      id: 'step-m',
      name: 'Mask',
      type: 'anonymize',
      config: { orgId: 'org-1', templateId: 'tpl-gdpr-standard' },
      continueOnError: false,
    };
    const templates = [
      { id: 'tpl-gdpr-standard', name: 'GDPR', builtIn: true, objects: ['Contact', 'Lead'] },
    ];
    const { rerender } = render(
      <StepConfigPanel step={anonymize} onUpdate={onUpdate} maskingTemplates={templates} />,
    );
    const object = screen.getByTestId('config-masking-object') as HTMLSelectElement;
    expect([...object.options].map((option) => option.value)).toEqual(['', 'Contact', 'Lead']);
    expect(screen.queryByTestId('config-masking-where')).toBeNull();
    fireEvent.change(object, { target: { value: 'Contact' } });
    expect(onUpdate).toHaveBeenLastCalledWith('step-m', {
      config: { orgId: 'org-1', templateId: 'tpl-gdpr-standard', object: 'Contact' },
    });
    rerender(
      <StepConfigPanel
        step={{ ...anonymize, config: { ...anonymize.config, object: 'Contact' } }}
        onUpdate={onUpdate}
        maskingTemplates={templates}
      />,
    );
    expect(screen.getByTestId('config-masking-where')).toBeDefined();
    expect(screen.getByTestId('config-masking-note').textContent).toContain('snapshot');
  });

  it('asks a Checkpoint step what it takes, and the objects only for a take of picked objects', () => {
    const onUpdate = vi.fn();
    const checkpoint: PipelineStep = {
      id: 'step-c',
      name: 'Take',
      type: 'checkpoint',
      config: { orgId: 'org-1', mode: 'everything' },
      continueOnError: false,
    };
    render(<StepConfigPanel step={checkpoint} onUpdate={onUpdate} />);
    expect(screen.queryByTestId('config-checkpoint-objects')).toBeNull();
    fireEvent.change(screen.getByTestId('config-checkpoint-mode'), { target: { value: 'picked' } });
    expect(onUpdate).toHaveBeenCalledWith('step-c', {
      config: { orgId: 'org-1', mode: 'picked' },
    });
    fireEvent.change(screen.getByTestId('config-checkpoint-keepDays'), { target: { value: '0' } });
    expect(onUpdate).toHaveBeenLastCalledWith('step-c', {
      config: { orgId: 'org-1', mode: 'everything', keepDays: 0 },
    });
    expect(screen.getByTestId('config-checkpoint-note').textContent).toContain('{date}');
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

describe('StepConfigPanel — Approval, Condition and Sync', () => {
  it('asks an Approval step for its message and how many minutes it waits, an hour unless set', () => {
    const onUpdate = vi.fn();
    render(
      <StepConfigPanel
        step={{
          id: 'step-a',
          name: 'Look first',
          type: 'approval',
          config: {},
          continueOnError: false,
        }}
        onUpdate={onUpdate}
      />,
    );

    const minutes = screen.getByTestId('config-timeoutMinutes') as HTMLInputElement;
    expect(minutes.placeholder).toBe('60');
    expect(minutes.max).toBe('1440');
    fireEvent.change(minutes, { target: { value: '15' } });
    expect(onUpdate).toHaveBeenLastCalledWith('step-a', { config: { timeoutMinutes: 15 } });
    fireEvent.change(screen.getByTestId('config-message'), { target: { value: 'Check it.' } });
    expect(onUpdate).toHaveBeenLastCalledWith('step-a', { config: { message: 'Check it.' } });
    expect((screen.getByTestId('config-message') as HTMLInputElement).maxLength).toBe(500);
  });

  it('removes the wait when it is cleared, rather than setting it to 0', () => {
    const onUpdate = vi.fn();
    render(
      <StepConfigPanel
        step={{
          id: 'step-a',
          name: 'Look first',
          type: 'approval',
          config: { timeoutMinutes: 15 },
          continueOnError: false,
        }}
        onUpdate={onUpdate}
      />,
    );

    fireEvent.change(screen.getByTestId('config-timeoutMinutes'), { target: { value: '' } });
    expect(onUpdate).toHaveBeenLastCalledWith('step-a', { config: {} });
  });

  it('gives a Condition step its test: the previous step, or a count above a number', () => {
    const onUpdate = vi.fn();
    const condition: PipelineStep = {
      id: 'step-c',
      name: 'Gate',
      type: 'condition',
      config: {},
      continueOnError: false,
    };
    const { rerender } = render(<StepConfigPanel step={condition} onUpdate={onUpdate} />);

    fireEvent.change(screen.getByTestId('config-condition-kind'), {
      target: { value: 'previousFailed' },
    });
    expect(onUpdate).toHaveBeenLastCalledWith('step-c', {
      condition: { field: 'previousStepStatus', operator: 'eq', value: 'failed' },
    });
    expect(screen.queryByTestId('config-condition-threshold')).toBeNull();

    rerender(
      <StepConfigPanel
        step={{
          ...condition,
          condition: { field: 'compareDifferenceCount', operator: 'gt', value: 0 },
        }}
        onUpdate={onUpdate}
      />,
    );
    expect((screen.getByTestId('config-condition-kind') as HTMLSelectElement).value).toBe(
      'compareDifferences',
    );
    fireEvent.change(screen.getByTestId('config-condition-threshold'), {
      target: { value: '25' },
    });
    expect(onUpdate).toHaveBeenLastCalledWith('step-c', {
      condition: { field: 'compareDifferenceCount', operator: 'gt', value: 25 },
    });
  });

  it('shows a condition a template set as it stands until another is chosen', () => {
    render(
      <StepConfigPanel
        step={{
          id: 'step-c',
          name: 'Gate',
          type: 'condition',
          config: {},
          continueOnError: false,
          condition: { field: 'env', operator: 'eq', value: 'prod' },
        }}
        onUpdate={vi.fn()}
      />,
    );

    const kind = screen.getByTestId('config-condition-kind') as HTMLSelectElement;
    expect(kind.value).toBe('custom');
    expect(kind.selectedOptions[0].textContent).toBe('As the template set it: env eq prod');
  });

  it('asks a Sync step for one of the saved Sync configurations, and says when there is none', () => {
    const onUpdate = vi.fn();
    const sync: PipelineStep = {
      id: 'step-s',
      name: 'Copy',
      type: 'sync',
      config: {},
      continueOnError: false,
    };
    const { rerender } = render(
      <StepConfigPanel
        step={sync}
        onUpdate={onUpdate}
        syncConfigs={[
          { id: 'cfg-1', name: 'Accounts to dev', valid: true, guard: 'allowed' },
          { id: 'cfg-2', name: 'Contacts', valid: true, guard: 'asks' },
        ]}
      />,
    );

    const picker = screen.getByTestId('config-configId') as HTMLSelectElement;
    expect([...picker.options].map((option) => option.textContent)).toEqual([
      'Choose a configuration',
      'Accounts to dev',
      'Contacts',
    ]);
    fireEvent.change(picker, { target: { value: 'cfg-2' } });
    expect(onUpdate).toHaveBeenLastCalledWith('step-s', { config: { configId: 'cfg-2' } });
    // The source and target org boxes the step used to ask for are gone.
    expect(screen.queryByTestId('config-sourceOrg')).toBeNull();

    rerender(<StepConfigPanel step={sync} onUpdate={onUpdate} syncConfigs={[]} />);
    expect(screen.getByTestId('config-sync-none').textContent).toBe(
      'No Sync configuration is saved yet: save one on the Sync page.',
    );
  });

  it('keeps a Sync configuration that is no longer saved chosen, and says so', () => {
    render(
      <StepConfigPanel
        step={{
          id: 'step-s',
          name: 'Copy',
          type: 'sync',
          config: { configId: 'cfg-gone' },
          continueOnError: false,
        }}
        syncConfigs={[{ id: 'cfg-1', name: 'Accounts to dev', valid: true }]}
      />,
    );

    const picker = screen.getByTestId('config-configId') as HTMLSelectElement;
    expect(picker.value).toBe('cfg-gone');
    expect(picker.selectedOptions[0].textContent).toBe('A configuration that is no longer saved');
  });
});
