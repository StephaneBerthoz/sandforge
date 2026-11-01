import { afterEach, describe, it, expect, vi } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import i18n from '../../i18n';
import fr from '../../i18n/locales/fr.json';
import { PipelineCanvas } from './PipelineCanvas';
import type { PipelineStep } from '@sandforge/shared';

const steps: PipelineStep[] = [
  { id: 's1', name: 'Backup Data', type: 'backup', config: {}, continueOnError: false },
  { id: 's2', name: 'Anonymize PII', type: 'anonymize', config: {}, continueOnError: true },
  {
    id: 's3',
    name: 'Sync to Dev',
    type: 'sync',
    config: {},
    continueOnError: false,
    onSuccess: 's4',
  },
];

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('PipelineCanvas', () => {
  it('should render the canvas', () => {
    render(<PipelineCanvas />);
    expect(screen.getByTestId('pipeline-canvas')).toBeDefined();
  });

  it('says how to start a pipeline when none is open, and never to drag a step', () => {
    // It said "Drag a step to the canvas / Connect steps to define flow" on a
    // page with no drag and drop and nothing that connects steps.
    render(<PipelineCanvas />);
    const canvas = screen.getByTestId('pipeline-canvas');
    expect(canvas.getAttribute('data-empty')).toBe('no-pipeline');
    expect(canvas.textContent).toContain('No pipeline open');
    expect(canvas.textContent).toContain(
      'Click Create Pipeline or Generate with AI to start one, or click a step under Steps to start one with it.',
    );
    expect(canvas.textContent).not.toMatch(/drag|connect/i);
  });

  it('says how to add a step to an open pipeline with none, and in what order steps run', () => {
    render(<PipelineCanvas steps={[]} hasPipeline />);
    const canvas = screen.getByTestId('pipeline-canvas');
    expect(canvas.getAttribute('data-empty')).toBe('no-steps');
    expect(canvas.textContent).toContain('No step yet');
    expect(canvas.textContent).toContain(
      'Click a step under Steps to add it. Steps run top to bottom.',
    );
  });

  it('should show step nodes', () => {
    render(<PipelineCanvas steps={steps} />);
    expect(screen.getByTestId('canvas-step-s1')).toBeDefined();
    expect(screen.getByTestId('canvas-step-s2')).toBeDefined();
    expect(screen.getByTestId('canvas-step-s3')).toBeDefined();
  });

  it('should show step names', () => {
    render(<PipelineCanvas steps={steps} />);
    expect(screen.getByText('Backup Data')).toBeDefined();
    expect(screen.getByText('Anonymize PII')).toBeDefined();
  });

  it('names the type of a renamed step in the reader’s language, never by its id', async () => {
    // "approval approval", "backup backup": the raw id, in every language.
    render(<PipelineCanvas steps={steps} />);
    expect(screen.getByTestId('canvas-step-s1').textContent).toContain('Backup');
    expect(screen.getByTestId('canvas-step-s2').textContent).toContain('Anonymize');
    expect(screen.queryByText('backup')).toBeNull();
    expect(screen.queryByText('anonymize')).toBeNull();
    i18n.addResourceBundle('fr', 'translation', fr, true, true);
    await act(() => i18n.changeLanguage('fr'));
    expect(screen.getByTestId('canvas-step-s1').textContent).toContain('Sauvegarde');
  });

  it('leaves out the type badge beside a step still named after its type', () => {
    render(
      <PipelineCanvas
        steps={[
          { id: 'a', name: 'Approval', type: 'approval', config: {}, continueOnError: false },
          { id: 'b', name: 'Approval 2', type: 'approval', config: {}, continueOnError: false },
          { id: 'c', name: 'QA sign-off', type: 'approval', config: {}, continueOnError: false },
        ]}
      />,
    );
    expect(screen.getByTestId('canvas-step-a').textContent).toBe('Approval');
    expect(screen.getByTestId('canvas-step-b').textContent).toBe('Approval 2');
    expect(screen.getByTestId('canvas-step-c').textContent).toBe('QA sign-offApproval');
  });

  it('should show continue on error badge', () => {
    render(<PipelineCanvas steps={steps} />);
    expect(screen.getByText('Continue on Error')).toBeDefined();
  });

  it('should call onSelectStep when clicked', () => {
    const onSelect = vi.fn();
    render(<PipelineCanvas steps={steps} onSelectStep={onSelect} />);
    fireEvent.click(screen.getByTestId('canvas-step-s1'));
    expect(onSelect).toHaveBeenCalledWith('s1');
  });

  it('should call onRemoveStep when remove clicked', () => {
    const onRemove = vi.fn();
    const onSelect = vi.fn();
    render(<PipelineCanvas steps={steps} onRemoveStep={onRemove} onSelectStep={onSelect} />);
    fireEvent.click(screen.getByTestId('remove-step-s1'));
    expect(onRemove).toHaveBeenCalledWith('s1');
    // Removing a step does not select it on the way out.
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('marks the selected step for assistive technology as well as on screen', () => {
    render(<PipelineCanvas steps={steps} selectedStepId="s2" />);
    const step = screen.getByTestId('canvas-step-s2');
    expect(step.getAttribute('aria-current')).toBe('true');
    expect(step.parentElement?.className).toContain('--sf-accent');
    expect(screen.getByTestId('canvas-step-s1').hasAttribute('aria-current')).toBe(false);
  });

  it('puts no control inside another: selecting and removing are two buttons side by side', () => {
    // The step node was a role="button" div holding its remove button, which
    // a screen reader announces as one control (axe: nested-interactive).
    render(<PipelineCanvas steps={steps} onSelectStep={vi.fn()} onRemoveStep={vi.fn()} />);

    const controls = screen.getAllByRole('button');
    expect(controls).toHaveLength(steps.length * 2);
    for (const control of controls) {
      expect(control.tagName).toBe('BUTTON');
      expect(control.querySelector('button, [role="button"], [tabindex]')).toBeNull();
    }
    expect(
      screen.getByTestId('canvas-step-s1').contains(screen.getByTestId('remove-step-s1')),
    ).toBe(false);
  });

  it('lists the steps in the order they run', () => {
    render(<PipelineCanvas steps={steps} />);
    const list = screen.getByRole('list', { name: 'Pipeline Canvas' });
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining('Backup Data'),
      expect.stringContaining('Anonymize PII'),
      expect.stringContaining('Sync to Dev'),
    ]);
    expect(list.contains(items[0])).toBe(true);
  });

  it('marks each step that cannot run where it sits, with the reason', () => {
    // A Marketplace template or an AI draft lands here with steps the palette
    // would not add; the reader sees which ones before pressing Run.
    render(
      <PipelineCanvas
        steps={[
          ...steps,
          { id: 'c1', name: 'Gate', type: 'condition', config: {}, continueOnError: false },
          { id: 'd1', name: 'Pause', type: 'delay', config: {}, continueOnError: false },
          { id: 'd2', name: 'Wait', type: 'delay', config: { seconds: 5 }, continueOnError: false },
        ]}
      />,
    );

    // A Backup step runs, once it names the org it backs up.
    const backup = screen.getByTestId('canvas-blocked-s1');
    expect(backup.textContent).toBe('Cannot run');
    expect(backup.getAttribute('title')).toBe('Choose the org this step works on.');
    // Anonymize masks a chosen org, and this one names none.
    expect(screen.getByTestId('canvas-blocked-s2').getAttribute('title')).toBe(
      'Choose the org this step works on.',
    );
    expect(screen.getByTestId('canvas-blocked-s3')).toBeDefined();
    expect(screen.getByTestId('canvas-blocked-c1').getAttribute('title')).toBe(
      'Choose what this Condition step tests.',
    );
    expect(screen.getByTestId('canvas-blocked-d1').getAttribute('title')).toBe(
      'Set how many seconds this Delay step waits (from 0 up to 24 days).',
    );
    // A Delay step with its seconds runs, and is not marked.
    expect(screen.queryByTestId('canvas-blocked-d2')).toBeNull();
  });

  it('marks a step of a type SandForge no longer has as no longer supported, and says to remove it', () => {
    // A pipeline saved by an earlier release can hold one: it still loads.
    render(
      <PipelineCanvas
        steps={[
          {
            id: 'old',
            name: 'Run tests',
            type: 'script' as PipelineStep['type'],
            config: { language: 'apex' },
            continueOnError: false,
          },
        ]}
      />,
    );

    const badge = screen.getByTestId('canvas-blocked-old');
    expect(badge.textContent).toBe('No longer supported');
    expect(badge.getAttribute('title')).toBe(
      'This step type is no longer supported: remove the step from the pipeline.',
    );
  });

  it('marks a Sync into an org Production Guard asks about until an Approval step comes before it', () => {
    const syncConfigs = [
      {
        id: 'cfg-1',
        name: 'Accounts',
        valid: true,
        sourceOrgId: 'org-a',
        targetOrgId: 'org-b',
        guard: 'asks' as const,
      },
    ];
    const sync: PipelineStep = {
      id: 'sync',
      name: 'Copy',
      type: 'sync',
      config: { configId: 'cfg-1' },
      continueOnError: false,
    };
    const approval: PipelineStep = {
      id: 'ok',
      name: 'Look first',
      type: 'approval',
      config: {},
      continueOnError: false,
    };

    const { unmount } = render(<PipelineCanvas steps={[sync]} syncConfigs={syncConfigs} />);
    expect(screen.getByTestId('canvas-blocked-sync').getAttribute('title')).toContain(
      'put an Approval step before it',
    );
    unmount();

    render(<PipelineCanvas steps={[approval, sync]} syncConfigs={syncConfigs} />);
    expect(screen.queryByTestId('canvas-blocked-sync')).toBeNull();
    expect(screen.queryByTestId('canvas-blocked-ok')).toBeNull();
  });
});
