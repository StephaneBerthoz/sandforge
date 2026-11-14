import { describe, expect, it } from 'vitest';
import type { PipelineFileOrg, SandforgePipelineFile } from '@sandforge/shared';
import {
  aliasesOf,
  checkRefusals,
  fileRefusals,
  historyEntryOf,
  namedStepRefusals,
  parseArgs,
  runExit,
  settingOf,
  takeBackOf,
  variablesOf,
  type RunOrg,
} from './sandforge-pipeline.js';

/*
 * What `sandforge pipeline` settles before it reaches any org: its line, the
 * orgs and variables of the file, the refusals it adds to the editor's
 * check, the lines that take a run back, and the codes it ends with.
 */

const line = (...words: string[]): string[] => ['node', 'sandforge-pipeline.ts', ...words];

const UAT: PipelineFileOrg = {
  alias: 'UAT',
  organizationId: '00D000000000009AAA',
  kind: 'sandbox',
  staging: false,
};

/** A file of the fields these functions read. */
function fileOf(fields: Partial<SandforgePipelineFile['pipeline']> = {}): SandforgePipelineFile {
  return {
    sandforgePipeline: 1,
    exportedAt: '2026-11-20T10:00:00.000Z',
    exportedBy: 'SandForge 1.81.0',
    digest: `sha256:${'0'.repeat(64)}`,
    pipeline: {
      id: 'pipe-1',
      name: 'Nightly',
      description: '',
      steps: [],
      variables: [],
      tags: [],
      ...fields,
    },
    schedule: null,
    orgs: { 'reg-uat': UAT },
    syncConfigs: {},
    seedTemplates: {},
    maskingTemplates: {},
    settings: {},
    notes: [],
  };
}

/** Throws what parsing the line throws, as its message. */
function refusalOf(words: string[]): string {
  try {
    parseArgs(line(...words));
  } catch (err: unknown) {
    return (err as Error).message;
  }
  throw new Error('the line was read');
}

describe('parseArgs', () => {
  it('reads a run’s line: the orgs, the variables, the answers ahead, and its switches', () => {
    const args = parseArgs(
      line(
        'run',
        '--file',
        'nightly.json',
        '--org',
        'reg-uat=UAT',
        '--var',
        'ticket=T-1',
        '--var-env',
        'token=PIPE_TOKEN',
        '--approve',
        'Go?',
        '--dry-run',
        '--timeout',
        '60000',
        '--triggered-by',
        'schedule',
        '--fail-on-partial',
      ),
      { PIPE_TOKEN: 'secret' },
    );

    expect(args).toMatchObject({
      verb: 'run',
      file: 'nightly.json',
      approve: ['Go?'],
      dryRun: true,
      timeoutMs: 60_000,
      triggeredBy: 'schedule',
      failOnPartial: true,
    });
    expect(args.orgs.get('reg-uat')).toBe('UAT');
    expect(args.vars.get('ticket')).toEqual({ value: 'T-1' });
    expect(args.vars.get('token')).toEqual({ env: 'PIPE_TOKEN', value: 'secret' });
  });

  it('refuses a flag the verb does not read, as a plan given --dry-run', () => {
    expect(refusalOf(['plan', '--file', 'f.json', '--dry-run'])).toBe(
      '"--dry-run" is not a flag this command reads. Nothing was run.',
    );
  });

  it('refuses an unknown verb, a missing file, a pair without its value, and a timeout out of bounds', () => {
    expect(refusalOf(['go', '--file', 'f.json'])).toContain(
      '"go" is not a command of sandforge pipeline',
    );
    expect(refusalOf(['run'])).toBe('--file names the pipeline file. Nothing was run.');
    expect(refusalOf(['run', '--file', 'f.json', '--org', 'reg-uat='])).toContain(
      '--org takes <key>=<value>',
    );
    expect(refusalOf(['run', '--file', 'f.json', '--timeout', '1000'])).toContain(
      '--timeout takes milliseconds from 30000 to 3600000',
    );
    expect(refusalOf(['run', '--file', 'f.json', '--accept-org', 'reg-uat=UAT'])).toContain(
      'is no Organization Id',
    );
  });
});

describe('aliasesOf', () => {
  it('takes the alias the line gives over the file’s, and refuses an org with neither, and a key the file lacks', () => {
    const file = {
      orgs: {
        'reg-uat': UAT,
        'reg-dev': { ...UAT, alias: undefined } as unknown as PipelineFileOrg,
      },
    };

    const read = aliasesOf(
      file,
      new Map([
        ['reg-uat', 'UAT2'],
        ['reg-x', 'X'],
      ]),
    );

    expect(read.orgs.map((org) => [org.key, org.alias])).toEqual([['reg-uat', 'UAT2']]);
    expect(read.refusals.map((refusal) => refusal.code)).toEqual([
      'ORG_UNKNOWN_KEY',
      'ORG_NO_ALIAS',
    ]);
  });
});

describe('variablesOf', () => {
  it('hands on the values given and the file’s defaults, and refuses a required one nothing gives, saying a secret never travels', () => {
    const file = fileOf({
      variables: [
        { name: 'ticket', type: 'string', required: true, description: '' },
        { name: 'token', type: 'secret', required: true, description: '' },
        { name: 'size', type: 'number', required: false, defaultValue: '5', description: '' },
      ],
    });

    const read = variablesOf(file, new Map([['ticket', { value: 'T-1' }]]));

    expect(read.values).toEqual({ ticket: 'T-1', size: '5' });
    expect(read.refusals).toEqual([
      expect.objectContaining({
        code: 'VARIABLE_MISSING',
        message: expect.stringContaining('a secret never travels in it'),
        wayOut: '--var-env token=<environment variable that holds it>',
      }),
    ]);
  });

  it('refuses a variable read from an environment variable that is not set', () => {
    const file = fileOf({
      variables: [{ name: 'token', type: 'secret', required: true, description: '' }],
    });

    expect(variablesOf(file, new Map([['token', { env: 'PIPE_TOKEN' }]])).refusals).toEqual([
      expect.objectContaining({
        code: 'VARIABLE_MISSING',
        wayOut: 'set PIPE_TOKEN in the environment the run starts in.',
      }),
    ]);
  });
});

describe('namedStepRefusals', () => {
  it('refuses a --confirm-rewind alias no Rewind step’s org is reached by', () => {
    const file = fileOf({
      steps: [
        {
          id: 's1',
          name: 'Back',
          type: 'rewind',
          config: { orgId: 'reg-uat', checkpointId: 'c1' },
        },
      ],
    });
    const orgs: RunOrg[] = [{ key: 'reg-uat', alias: 'UAT', file: UAT }];

    expect(namedStepRefusals(file, { approve: [], confirmRewind: ['UAT'] }, orgs)).toEqual([]);
    expect(namedStepRefusals(file, { approve: [], confirmRewind: ['DEV'] }, orgs)).toEqual([
      expect.objectContaining({ code: 'CONFIRM_UNKNOWN_ORG', wayOut: 'name UAT.' }),
    ]);
  });
});

describe('checkRefusals', () => {
  it('names a problem of the whole pipeline once, beside the steps refused where they sit', () => {
    const file = fileOf({
      steps: [
        { id: 's1', name: 'Fill', type: 'seed', config: { orgId: 'reg-uat', templateId: 't' } },
      ],
    });
    const check = {
      exported: true as const,
      pipelineId: 'pipe-1',
      steps: [
        {
          stepId: 's1',
          name: 'Fill',
          type: 'seed',
          fate: 'refused' as const,
          notes: [],
          refusal: 'Seed step "Fill" names no template.',
        },
      ],
      problems: ['Seed step "Fill" names no template.', 'Step "Fill" routes back to itself.'],
    } as unknown as Parameters<typeof checkRefusals>[1];

    expect(
      checkRefusals(file, check, [{ key: 'reg-uat', alias: 'UAT', file: UAT, kind: 'sandbox' }], {
        approve: [],
        isTTY: false,
      }).map((refusal) => [refusal.code, refusal.message]),
    ).toEqual([
      ['STEP_REFUSED', 'Seed step "Fill" names no template.'],
      ['PIPELINE_REFUSED', 'Step "Fill" routes back to itself.'],
    ]);
  });
});

describe('settingOf', () => {
  it('reads the line’s timeout, then the file’s settings, then the extension’s defaults', () => {
    const file = { settings: { 'sync.maxRecordsPerObject': 1_000 } };

    expect(settingOf(file, 60_000)('pipeline.timeout', 1)).toBe(60_000);
    expect(settingOf(file, undefined)('pipeline.timeout', 1)).toBe(300_000);
    expect(settingOf(file, undefined)('sync.maxRecordsPerObject', 1)).toBe(1_000);
    expect(settingOf(file, undefined)('checkpoint.beforeRunKeepDays', 7)).toBe(7);
  });
});

describe('takeBackOf', () => {
  const alias = (orgId: string): string | undefined => (orgId === '00D9' ? 'UAT' : undefined);
  const target = (configId: string): string | undefined => (configId === 'cfg' ? 'UAT' : undefined);
  const of = (stepType: string, output: Record<string, unknown>) =>
    takeBackOf(
      { stepType: stepType as never, status: 'completed', output },
      alias,
      '/store',
      target,
    );

  it('names the command that takes back what each step wrote', () => {
    expect(of('seed', { orgId: '00D9', runId: 'r1', totalRecordsCreated: 2 })).toMatch(
      /sandforge-seed\.ts --remove r1 --target UAT$/,
    );
    expect(of('sync', { configId: 'cfg', operationId: 'o1', totalSuccess: 3 })).toMatch(
      /sandforge-sync\.ts --remove o1 --target UAT --store \/store$/,
    );
    expect(of('anonymize', { orgId: '00D9', snapshot: { operationId: 'b1' } })).toMatch(
      /sandforge-dataops\.ts anonymize --org UAT --restore b1$/,
    );
    expect(of('rewind', { orgId: '00D9', checkpointId: 'c1', undoUntil: '2026-12-01' })).toMatch(
      /sandforge-checkpoint\.ts undo --org UAT --checkpoint c1$/,
    );
    expect(of('checkpoint', { orgId: '00D9', checkpointId: 'c1' })).toMatch(
      /sandforge-checkpoint\.ts delete --org UAT --checkpoint c1$/,
    );
  });

  it('names none for a step that wrote nothing, nor for a dry run', () => {
    expect(of('seed', { orgId: '00D9', runId: 'r1', totalRecordsCreated: 0 })).toBeUndefined();
    expect(
      of('seed', { orgId: '00D9', runId: 'r1', totalRecordsCreated: 2, dryRun: true }),
    ).toBeUndefined();
    expect(of('compare', { orgId: '00D9' })).toBeUndefined();
  });
});

describe('runExit', () => {
  it('ends 0, 3 with --fail-on-partial, 1 on a failure, and the signal’s code on a stop', () => {
    expect(runExit({ status: 'completed' }, true, undefined)).toBe(0);
    expect(runExit({ status: 'completed_with_warnings' }, false, undefined)).toBe(0);
    expect(runExit({ status: 'completed_with_warnings' }, true, undefined)).toBe(3);
    expect(runExit({ status: 'failed' }, false, undefined)).toBe(1);
    expect(runExit({ status: 'cancelled' }, false, 'SIGTERM')).toBe(143);
    expect(runExit({ status: 'cancelled' }, false, undefined)).toBe(1);
  });
});

describe('historyEntryOf', () => {
  it('keeps the run as the History tab lists it, marked the command line’s and started as the launcher says', () => {
    const entry = historyEntryOf(
      {
        id: 'run-1',
        pipelineId: 'pipe-1',
        pipelineName: 'Nightly',
        status: 'completed',
        triggeredBy: 'manual',
        variables: { token: 'secret' },
        startTime: '2026-11-20T02:00:00.000Z',
        duration: 12,
        stepResults: [
          { stepId: 's1', stepName: 'Wait', stepType: 'delay', status: 'completed', duration: 1 },
          { stepId: 's2', stepName: 'Skip', stepType: 'delay', status: 'skipped' },
        ],
      },
      'schedule',
    );

    expect(entry).toMatchObject({
      triggeredBy: 'schedule',
      stepCount: 1,
      errorCount: 0,
      ranFrom: 'commandLine',
    });
    expect(JSON.stringify(entry)).not.toContain('secret');
  });
});

describe('fileRefusals', () => {
  it('lists each issue of a file that does not read', () => {
    expect(
      fileRefusals(
        {
          code: 'PIPELINE_FILE_INVALID',
          message: 'This pipeline file does not read: 2 issues.',
          issues: [
            { path: 'orgs.a.organizationId', message: 'not an Id' },
            { path: 'pipeline.name', message: 'empty' },
          ],
        },
        'run',
        'f.json',
      ).map((refusal) => refusal.message),
    ).toEqual([
      'This pipeline file does not read: 2 issues.',
      'orgs.a.organizationId: not an Id',
      'pipeline.name: empty',
    ]);
  });
});
