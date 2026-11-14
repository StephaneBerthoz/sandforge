import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '../../i18n';
import type { PipelineDefinition, PipelineExportOutcome } from '@sandforge/shared';
import { ExportPipelineDialog } from './ExportPipelineDialog';

/**
 * The names the export dialog gives what a keyboard or a screen reader
 * reaches: the dialog by its title, each section by its heading, each launcher
 * and the hand-over box by their own words. axe in the rendered themes is the
 * authority on contrast; this holds the names.
 */

const mockPostMessage = vi.fn();
const api = {
  postMessage: (...args: unknown[]) => mockPostMessage(...args),
  getState: () => undefined,
  setState: () => undefined,
};

vi.mock('../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => api,
  getVscodeApi: () => api,
}));

HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
  this.setAttribute('open', '');
};

const SAVED: PipelineDefinition = {
  id: 'pipe-1',
  name: 'Nightly reset',
  description: '',
  version: 1,
  steps: [],
  triggers: [],
  variables: [],
  tags: [],
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};

const OUTCOME: PipelineExportOutcome = {
  exported: true,
  pipelineId: 'pipe-1',
  fileName: 'nightly-reset.sandforge-pipeline.json',
  text: '{}',
  digest: `sha256:${'d'.repeat(64)}`,
  schedule: { cron: '0 2 * * *', timezone: 'UTC' },
  steps: [{ stepId: 's-1', name: 'Diff', type: 'compare', fate: 'runs', notes: [] }],
  orgs: [
    {
      key: 'org-1',
      alias: 'UAT',
      kind: 'sandbox',
      staging: false,
      cliHolds: true,
      writtenBy: [],
      readBy: ['Diff'],
    },
  ],
  variables: [{ name: 'TOKEN', type: 'secret', required: true, valued: false, env: 'TOKEN_ENV' }],
  launchers: {
    cron: {
      runner: 'cron',
      fileName: 'nightly-reset.sh',
      text: '#!/usr/bin/env bash',
      schedule: {
        kind: 'line',
        text: '0 2 * * *',
        timezone: 'UTC',
        offsetMinutes: 0,
        offsetChanges: [],
      },
    },
    taskScheduler: { runner: 'taskScheduler', fileName: 'nightly-reset.ps1', text: '' },
    githubActions: { runner: 'githubActions', fileName: 'nightly-reset.yml', text: '' },
  },
  notes: [],
  problems: [],
};

function openExported(): void {
  render(<ExportPipelineDialog pipeline={SAVED} onClose={vi.fn()} onHandedOver={vi.fn()} />);
  const request = mockPostMessage.mock.calls
    .map((call) => (call[0] as { payload: { id: string; type: string } }).payload)
    .find((message) => message.type === 'pipeline:export');
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          id: 'host-1',
          type: 'pipeline:export:response',
          timestamp: Date.now(),
          correlationId: request?.id,
          payload: OUTCOME,
        },
      }),
    );
  });
}

/** Labels that name nothing: the accessible name is lost for their control. */
function orphanLabels(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll('label'))
    .filter((label) => label.control === null)
    .map((label) => (label.textContent ?? '').trim());
}

describe('ExportPipelineDialog accessible names', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
  });

  it('is a modal dialog named by its title and described by what it saves', () => {
    openExported();
    const dialog = screen.getByRole('dialog', { name: 'Export “Nightly reset”' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-describedby')).not.toBeNull();
  });

  it('names each section by its heading', () => {
    openExported();
    for (const name of [
      'Steps, with VS Code closed',
      'Orgs',
      'Variables',
      'What keeps two runs apart, and what does not',
    ]) {
      expect(screen.getByRole('region', { name }), name).toBeDefined();
    }
  });

  it('groups the launchers under their legend, each radio named by its words', () => {
    openExported();
    const group = screen.getByRole('group', { name: 'Launcher' });
    expect(group).toBeDefined();
    for (const name of [
      'None: the pipeline file alone',
      'bash, started by cron',
      'PowerShell, started by Task Scheduler',
      'GitHub Actions workflow',
    ]) {
      expect(screen.getByRole('radio', { name }), name).toBeDefined();
    }
  });

  it('names the hand-over box by what it does, and leaves no orphan label', () => {
    openExported();
    fireEvent.click(screen.getByRole('radio', { name: 'bash, started by cron' }));
    expect(
      screen.getByRole('checkbox', {
        name: /^Let this launcher start the pipeline: turn its schedule off here/,
      }),
    ).toBeDefined();
    expect(orphanLabels(screen.getByTestId('export-dialog'))).toEqual([]);
  });

  it('says the saves’ progress and outcome in a live status', () => {
    openExported();
    fireEvent.click(screen.getByTestId('export-save'));
    expect(screen.getByTestId('export-outcome').getAttribute('role')).toBe('status');
  });
});
