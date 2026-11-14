import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '../../i18n';
import type {
  PipelineDefinition,
  PipelineExport,
  PipelineExportOutcome,
  PipelineLauncher,
} from '@sandforge/shared';
import { ExportPipelineDialog } from './ExportPipelineDialog';

/**
 * The export dialog against the bridge as it is: what it asks the extension,
 * in which order, and what it says of each answer. A launcher is never
 * handed the schedule before it is saved beside the file it runs.
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

// jsdom has no modal dialog: open it as the browser would, without the top layer.
HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
  this.removeAttribute('open');
};

/** The messages the page sent, of one type, oldest first. */
function sent(type: string): Array<{ id: string; payload: Record<string, unknown> }> {
  return mockPostMessage.mock.calls
    .map(
      (call) =>
        (call[0] as { payload: { id: string; type: string; payload: Record<string, unknown> } })
          .payload,
    )
    .filter((message) => message.type === type);
}

/** The extension's answer to the request `correlationId`. */
function answer(type: string, correlationId: string, payload: unknown): void {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { id: `host-${correlationId}`, type, timestamp: Date.now(), correlationId, payload },
      }),
    );
  });
}

const DIGEST = `sha256:${'c'.repeat(64)}`;

/** The pipeline as saved, as `pipeline:list` reads it back: with the fields the store stamps. */
const SAVED = {
  id: 'pipe-1',
  name: 'Nightly reset',
  description: '',
  version: 2,
  steps: [],
  triggers: [
    {
      id: 'tr-s',
      type: 'schedule',
      enabled: true,
      config: { cron: '0 2 * * *', timezone: 'Europe/Paris' },
    },
    { id: 'tr-r', type: 'sandbox_refresh', enabled: true, config: { orgId: 'org-t' } },
  ],
  variables: [],
  tags: [],
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  key: 'pipeline:saved:pipe-1',
  savedAt: '2026-11-19T00:00:00.000Z',
} as unknown as PipelineDefinition;

function launcher(
  runner: PipelineLauncher['runner'],
  fileName: string,
  schedule?: PipelineLauncher['schedule'],
): PipelineLauncher {
  return { runner, fileName, text: `# ${runner} launcher`, ...(schedule ? { schedule } : {}) };
}

const CRON_LINE = {
  kind: 'line' as const,
  text: '0 2 * * * /bin/bash /path/to/nightly-reset.sh',
  timezone: 'Europe/Paris',
  offsetMinutes: 0,
  offsetChanges: [],
};

/** An export of a pipeline with one of each kind of step and org. */
function exported(overrides: Partial<PipelineExport> = {}): PipelineExportOutcome {
  return {
    exported: true,
    pipelineId: 'pipe-1',
    fileName: 'nightly-reset.sandforge-pipeline.json',
    text: '{"sandforgePipeline":1}',
    digest: DIGEST,
    schedule: { cron: '0 2 * * *', timezone: 'Europe/Paris' },
    steps: [
      { stepId: 's-cmp', name: 'Diff', type: 'compare', fate: 'runs', notes: [] },
      {
        stepId: 's-gate',
        name: 'Gate',
        type: 'approval',
        fate: 'asks',
        notes: ['APPROVAL_NEEDS_PERSON'],
      },
      {
        stepId: 's-rw',
        name: 'Back',
        type: 'rewind',
        fate: 'asks',
        notes: ['REWIND_NEEDS_CONFIRMATION', 'REWIND_CHECKPOINT_ELSEWHERE'],
      },
      {
        stepId: 's-del',
        name: 'Purge',
        type: 'delete',
        fate: 'refused',
        notes: ['STEP_REFUSED'],
        refusal: 'Step "Purge" is a Delete step, which a pipeline never runs.',
      },
    ],
    orgs: [
      {
        key: 'org-t',
        alias: 'UAT',
        kind: 'sandbox',
        staging: true,
        cliHolds: false,
        writtenBy: ['Back'],
        readBy: ['Diff'],
      },
      {
        key: 'org-s',
        name: 'Source Org',
        kind: 'scratch',
        staging: false,
        cliHolds: true,
        writtenBy: [],
        readBy: ['Diff'],
      },
    ],
    variables: [
      { name: 'TOKEN', type: 'secret', required: true, valued: false, env: 'SANDFORGE_VAR_TOKEN' },
      { name: 'LIMIT', type: 'number', required: false, valued: true },
    ],
    launchers: {
      cron: launcher('cron', 'nightly-reset.sh', CRON_LINE),
      taskScheduler: launcher('taskScheduler', 'nightly-reset.ps1', {
        kind: 'refused',
        code: 'notExact',
        reason: 'No line of this clock runs at those moments.',
      }),
      githubActions: launcher('githubActions', 'nightly-reset.yml', {
        ...CRON_LINE,
        text: '0 2 * * *',
      }),
    },
    notes: [],
    problems: [],
    ...overrides,
  } as PipelineExportOutcome;
}

function open(onHandedOver = vi.fn(), onClose = vi.fn()) {
  render(<ExportPipelineDialog pipeline={SAVED} onClose={onClose} onHandedOver={onHandedOver} />);
  const [request] = sent('pipeline:export');
  return { request, onHandedOver, onClose };
}

/** Open the dialog and answer its export. */
function openExported(outcome = exported(), onHandedOver = vi.fn()) {
  const opened = open(onHandedOver);
  answer('pipeline:export:response', opened.request.id, outcome);
  return opened;
}

/** Press Save, and answer the Save dialogs in turn, then the hand-over if one is sent. */
function saveWith(...answers: unknown[]) {
  fireEvent.click(screen.getByTestId('export-save'));
  answers.forEach((payload, index) => {
    const request = sent('file:save')[index];
    expect(request, `file:save #${index + 1} was not asked`).toBeDefined();
    answer('file:save:response', request.id, payload);
  });
}

describe('ExportPipelineDialog', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
  });

  it('asks for the export of the pipeline as saved, by its id, and says it reads it meanwhile', () => {
    const { request } = open();
    expect(request.payload).toEqual({ pipelineId: 'pipe-1' });
    expect(screen.getByTestId('export-reading').textContent).toBe('Reading the saved pipeline…');
    expect(screen.queryByTestId('export-save')).toBeNull();
  });

  it('says what each step does with VS Code closed: runs, asks what of whom, or is refused in the run’s words', () => {
    openExported();

    expect(screen.getByTestId('export-step-s-cmp').textContent).toContain('Runs as here');
    const gate = screen.getByTestId('export-step-s-gate').textContent ?? '';
    expect(gate).toContain('Asks something');
    expect(gate).toContain('--approve "Gate"');
    const rewind = screen.getByTestId('export-step-s-rw').textContent ?? '';
    expect(rewind).toContain('--confirm-rewind UAT');
    expect(rewind).toContain('import it first (sandforge checkpoint import)');
    const purge = screen.getByTestId('export-step-s-del').textContent ?? '';
    expect(purge).toContain('Refused');
    expect(purge).toContain('The run refuses it before its first step:');
    expect(purge).toContain('Step "Purge" is a Delete step, which a pipeline never runs.');
  });

  it('names each org with its kind, Staging, and the sign-in a machine of the run needs', () => {
    openExported();

    const uat = screen.getByTestId('export-org-org-t').textContent ?? '';
    expect(uat).toContain('UAT');
    expect(uat).toContain('Sandbox');
    expect(uat).toContain('Staging');
    expect(uat).toContain('Written by Back');
    expect(screen.getByTestId('export-org-login-org-t').textContent).toBe(
      'sf org login web --alias UAT --instance-url https://test.salesforce.com',
    );
    const source = screen.getByTestId('export-org-org-s').textContent ?? '';
    expect(source).toContain('Source Org');
    expect(source).toContain('Scratch org');
    expect(source).toContain('No alias of its own');
    expect(source).toContain('--org org-s=<alias>');
    expect(source).toContain('Signed in to the Salesforce CLI of this machine.');
  });

  it('says a secret stays out of the file, with the line that gives it to a run', () => {
    openExported();
    const secret = screen.getByTestId('export-variable-TOKEN').textContent ?? '';
    expect(secret).toContain('its value stays out of the file');
    expect(secret).toContain('--var-env TOKEN=SANDFORGE_VAR_TOKEN');
    expect(screen.getByTestId('export-variable-LIMIT').textContent).toContain(
      'Its value is in the file.',
    );
  });

  it('says what the run lock holds off and what it does not: other writers of the org, a masking’s restore, another machine', () => {
    openExported();
    const locks = screen.getByTestId('export-locks').textContent ?? '';
    expect(locks).toContain('take the same lock, and the second is refused');
    expect(locks).toContain('can write the same org at the same time');
    expect(locks).toContain('a restore from the command line or another window is not held off');
    expect(locks).toContain('A run on another machine');
  });

  it('says why the export was refused, in the reader’s words and the extension’s, and offers no save', () => {
    const { request } = open();
    answer('pipeline:export:response', request.id, {
      exported: false,
      pipelineId: 'pipe-1',
      code: 'FILE_INVALID',
      message: 'The pipeline file would not read: 1 issue.',
      issues: [{ path: 'settings.sync.maxRecordsPerObject', message: 'Too big' }],
    });

    const refused = screen.getByTestId('export-refused').textContent ?? '';
    expect(refused).toContain('The file would not read: fix each point below');
    expect(refused).toContain('The pipeline file would not read: 1 issue.');
    expect(refused).toContain('settings.sync.maxRecordsPerObject: Too big');
    expect(screen.queryByTestId('export-save')).toBeNull();
  });

  it('offers to hand the schedule over only for a launcher that starts on it, ticked as it is chosen', () => {
    openExported();
    expect(screen.queryByTestId('export-hand-over')).toBeNull();

    fireEvent.click(screen.getByTestId('export-launcher-cron'));
    expect((screen.getByTestId('export-hand-over') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId('export-launcher-line').textContent).toBe(
      '0 2 * * * /bin/bash /path/to/nightly-reset.sh',
    );

    // No line of Task Scheduler runs at those moments: it starts nothing by
    // itself, and VS Code keeps the schedule.
    fireEvent.click(screen.getByTestId('export-launcher-taskScheduler'));
    expect(screen.queryByTestId('export-hand-over')).toBeNull();
    expect(screen.getByTestId('export-launcher-refused').textContent).toContain(
      'No line of this clock runs at those moments.',
    );
  });

  it('offers no hand-over for a pipeline with no schedule, and says how its launcher is started', () => {
    openExported(
      exported({
        schedule: null,
        launchers: {
          cron: launcher('cron', 'nightly-reset.sh'),
          taskScheduler: launcher('taskScheduler', 'nightly-reset.ps1'),
          githubActions: launcher('githubActions', 'nightly-reset.yml'),
        },
      }),
    );
    fireEvent.click(screen.getByTestId('export-launcher-cron'));
    expect(screen.queryByTestId('export-hand-over')).toBeNull();
    expect(screen.getByTestId('export-launcher-facts').textContent).toContain(
      'The pipeline has no schedule',
    );
  });

  it('saves the file, then the launcher beside it, then the pipeline with its schedule off and who starts it', () => {
    const { onHandedOver } = openExported();
    fireEvent.click(screen.getByTestId('export-launcher-cron'));

    saveWith(
      { status: 'saved', path: '/home/me/pipelines/nightly-reset.sandforge-pipeline.json' },
      { status: 'saved', path: '/home/me/pipelines/nightly-reset.sh' },
    );

    const [file, sh] = sent('file:save');
    expect(file.payload).toEqual({
      suggestedName: 'nightly-reset.sandforge-pipeline.json',
      content: '{"sandforgePipeline":1}',
      extensions: ['json'],
    });
    expect(sh.payload).toEqual({
      suggestedName: 'nightly-reset.sh',
      content: '# cron launcher',
      extensions: ['sh'],
    });
    const [handOver] = sent('pipeline:save');
    const config = handOver.payload.config as PipelineDefinition & Record<string, unknown>;
    expect(handOver.payload.id).toBe('pipe-1');
    expect(config.triggers).toEqual([
      {
        id: 'tr-s',
        type: 'schedule',
        enabled: false,
        config: { cron: '0 2 * * *', timezone: 'Europe/Paris' },
      },
      { id: 'tr-r', type: 'sandbox_refresh', enabled: true, config: { orgId: 'org-t' } },
    ]);
    expect(config.runsOutside).toMatchObject({
      runner: 'cron',
      file: 'nightly-reset.sandforge-pipeline.json',
      digest: DIGEST,
    });
    expect(config).not.toHaveProperty('key');
    expect(config).not.toHaveProperty('savedAt');
    expect(onHandedOver).not.toHaveBeenCalled();

    answer('pipeline:save:response', handOver.id, { success: true, id: 'pipe-1' });

    expect(onHandedOver).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'pipe-1', runsOutside: config.runsOutside }),
    );
    expect(screen.getByTestId('export-saved-file').textContent).toBe(
      'Pipeline file saved: /home/me/pipelines/nightly-reset.sandforge-pipeline.json',
    );
    expect(screen.getByTestId('export-saved-launcher').textContent).toBe(
      'Launcher saved: /home/me/pipelines/nightly-reset.sh',
    );
    expect(screen.getByTestId('export-handed-over').textContent).toContain(
      'Its schedule is off in VS Code: cron (bash launcher) starts it from now on',
    );
    expect(screen.queryByTestId('export-save')).toBeNull();
  });

  it('turns no schedule off when the launcher’s Save dialog is closed, and says so', () => {
    const { onHandedOver } = openExported();
    fireEvent.click(screen.getByTestId('export-launcher-cron'));

    saveWith(
      { status: 'saved', path: '/home/me/pipelines/nightly-reset.sandforge-pipeline.json' },
      { status: 'cancelled' },
    );

    expect(sent('pipeline:save')).toHaveLength(0);
    expect(onHandedOver).not.toHaveBeenCalled();
    expect(screen.getByTestId('export-stopped').textContent).toBe(
      'The launcher was not saved: the Save dialog was closed. The schedule stays on in VS Code.',
    );
    // Asked again, the saves start over.
    expect(screen.getByTestId('export-save')).toBeDefined();
  });

  it('asks for no launcher once the file’s Save dialog is closed, and says nothing was saved', () => {
    openExported();
    fireEvent.click(screen.getByTestId('export-launcher-cron'));

    saveWith({ status: 'cancelled' });

    expect(sent('file:save')).toHaveLength(1);
    expect(screen.getByTestId('export-stopped').textContent).toBe(
      'Nothing was saved: the Save dialog was closed.',
    );
  });

  it('says why a launcher was not written, and keeps the schedule', () => {
    openExported();
    fireEvent.click(screen.getByTestId('export-launcher-cron'));

    saveWith(
      { status: 'saved', path: '/home/me/pipelines/nightly-reset.sandforge-pipeline.json' },
      { status: 'error', message: 'EACCES: permission denied' },
    );

    expect(sent('pipeline:save')).toHaveLength(0);
    const stopped = screen.getByTestId('export-stopped').textContent ?? '';
    expect(stopped).toContain('The launcher was not saved, and the schedule stays on in VS Code:');
    expect(stopped).toContain('EACCES: permission denied');
  });

  it('keeps the schedule when the file was saved under another name than the launcher runs', () => {
    const { onHandedOver } = openExported();
    fireEvent.click(screen.getByTestId('export-launcher-cron'));

    saveWith(
      { status: 'saved', path: '/home/me/pipelines/renamed.json' },
      { status: 'saved', path: '/home/me/pipelines/nightly-reset.sh' },
    );

    expect(sent('pipeline:save')).toHaveLength(0);
    expect(onHandedOver).not.toHaveBeenCalled();
    expect(screen.getByTestId('export-withheld').textContent).toContain(
      'the file was saved as renamed.json, and the launcher runs nightly-reset.sandforge-pipeline.json',
    );
  });

  it('keeps the schedule when cron’s launcher was saved apart from the file it runs from beside it', () => {
    openExported();
    fireEvent.click(screen.getByTestId('export-launcher-cron'));

    saveWith(
      { status: 'saved', path: '/home/me/pipelines/nightly-reset.sandforge-pipeline.json' },
      { status: 'saved', path: '/home/me/bin/nightly-reset.sh' },
    );

    expect(sent('pipeline:save')).toHaveLength(0);
    expect(screen.getByTestId('export-withheld').textContent).toContain(
      'the launcher was saved in another folder than the file',
    );
  });

  it('hands the schedule to a workflow saved in another folder: the repository places it', () => {
    openExported();
    fireEvent.click(screen.getByTestId('export-launcher-githubActions'));

    saveWith(
      { status: 'saved', path: '/home/me/repo/nightly-reset.sandforge-pipeline.json' },
      { status: 'saved', path: '/home/me/repo/.github/workflows/nightly-reset.yml' },
    );

    const [handOver] = sent('pipeline:save');
    expect((handOver.payload.config as PipelineDefinition).runsOutside?.runner).toBe(
      'githubActions',
    );
  });

  it('saves no hand-over when the box is unticked', () => {
    openExported();
    fireEvent.click(screen.getByTestId('export-launcher-cron'));
    fireEvent.click(screen.getByTestId('export-hand-over'));

    saveWith(
      { status: 'saved', path: '/home/me/pipelines/nightly-reset.sandforge-pipeline.json' },
      { status: 'saved', path: '/home/me/pipelines/nightly-reset.sh' },
    );

    expect(sent('pipeline:save')).toHaveLength(0);
    expect(screen.queryByTestId('export-handed-over')).toBeNull();
    expect(screen.getByTestId('export-saved-launcher')).toBeDefined();
  });

  it('saves the file alone with no launcher chosen', () => {
    openExported();
    expect(screen.getByTestId('export-save').textContent).toBe('Save the file…');

    saveWith({ status: 'saved', path: 'C:\\Users\\me\\nightly-reset.sandforge-pipeline.json' });

    expect(sent('file:save')).toHaveLength(1);
    expect(sent('pipeline:save')).toHaveLength(0);
    expect(screen.getByTestId('export-saved-file').textContent).toContain(
      'C:\\Users\\me\\nightly-reset.sandforge-pipeline.json',
    );
  });

  it('says the pipeline still starts in VS Code when the hand-over’s save is refused', () => {
    const { onHandedOver } = openExported();
    fireEvent.click(screen.getByTestId('export-launcher-cron'));
    saveWith(
      { status: 'saved', path: '/home/me/pipelines/nightly-reset.sandforge-pipeline.json' },
      { status: 'saved', path: '/home/me/pipelines/nightly-reset.sh' },
    );
    const [handOver] = sent('pipeline:save');

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            id: 'host-err',
            type: 'pipeline:error',
            timestamp: Date.now(),
            correlationId: handOver.id,
            payload: {
              message: 'The pipeline was not saved: runsOutside.file',
              code: 'INVALID_PAYLOAD',
            },
          },
        }),
      );
    });

    expect(onHandedOver).not.toHaveBeenCalled();
    const stopped = screen.getByTestId('export-stopped').textContent ?? '';
    expect(stopped).toContain('VS Code still starts it');
  });
});
