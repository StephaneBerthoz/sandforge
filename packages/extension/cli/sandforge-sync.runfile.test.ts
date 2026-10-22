import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Connection } from 'jsforce';
import type { SyncConfig, SyncExecutionResult } from '@sandforge/shared';
import type { SyncOrchestratorDeps } from '../src/modules/sync/SyncOrchestrator.js';
import { MemoryRemovalOrg } from '../src/test/memoryRemovalOrg.js';
import { SYNC_RUNS_DIR, readRunFile } from '../src/modules/sync/SyncRunCreations.js';

vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./sfSession.js', () => ({
  loadOrg: vi.fn(async (alias: string) => ({ alias })),
  makeConn: vi.fn(),
}));
vi.mock('../src/modules/forge/ForgeRunRemoval.js', async (original) => ({
  ...(await original<typeof import('../src/modules/forge/ForgeRunRemoval.js')>()),
  removalOrg: vi.fn(),
}));

/** What each run handed the engine, and what the engine does with it. */
const engine = vi.hoisted(() => ({
  run: undefined as
    undefined | ((deps: SyncOrchestratorDeps, config: SyncConfig) => Promise<SyncExecutionResult>),
}));
vi.mock('../src/modules/sync/SyncOrchestrator.js', () => ({
  SyncOrchestrator: vi.fn(function (this: unknown, deps: SyncOrchestratorDeps) {
    return {
      execute: (config: SyncConfig) => {
        if (!engine.run) throw new Error('no engine run set');
        return engine.run(deps, config);
      },
    };
  }),
}));

import { makeConn } from './sfSession.js';
import { removalOrg } from '../src/modules/forge/ForgeRunRemoval.js';
import { main, runFileOf } from './sandforge-sync.js';

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const ORG_ID = '00D000000000002AAA';
const A1 = fakeId('001', 1);
const C1 = fakeId('003', 1);
const C2 = fakeId('003', 2);
const JOB = fakeId('750', 1);

const argv = (...args: string[]): string[] => ['node', 'sandforge-sync.ts', ...args];

/** The directory the command keeps its runs' files in, under this file's journal directory. */
const runsDir = (): string => join(process.env['SANDFORGE_JOURNAL_DIR'] ?? '', SYNC_RUNS_DIR);

/** The run files the command kept, by name. */
const runFiles = (): string[] =>
  existsSync(runsDir()) ? readdirSync(runsDir()).filter((name) => name.endsWith('.ndjson')) : [];

/** A run's result, as the engine answers it. */
function answered(
  config: SyncConfig,
  extra: Partial<SyncExecutionResult> = {},
): SyncExecutionResult {
  return {
    configId: config.id,
    operationId: 'op-1',
    status: 'success',
    objectResults: [],
    totalProcessed: 1,
    totalSuccess: 1,
    totalFailed: 0,
    totalSkipped: 0,
    duration: 10,
    timestamp: new Date().toISOString(),
    ...extra,
  };
}

describe('the file a run of sandforge-sync keeps', () => {
  let stdout: string;
  let stderr: string;
  let org: MemoryRemovalOrg;
  let bulkJob: { state: string; rows: Array<Record<string, unknown>> };
  let jobsAsked: string[];

  beforeEach(() => {
    rmSync(runsDir(), { recursive: true, force: true });
    org = new MemoryRemovalOrg({
      Account: [{ childSObject: 'Contact', field: 'AccountId', cascadeDelete: true }],
    });
    vi.mocked(removalOrg).mockReturnValue(org);
    bulkJob = { state: 'JobComplete', rows: [] };
    jobsAsked = [];
    vi.mocked(makeConn).mockReturnValue({
      query: vi.fn(async (soql: string) =>
        soql.startsWith('SELECT Id, IsSandbox')
          ? { records: [{ Id: ORG_ID, IsSandbox: false }], totalSize: 1 }
          : soql.startsWith('SELECT OrganizationType')
            ? { records: [{ OrganizationType: 'Developer Edition' }], totalSize: 1 }
            : { records: [{ Id: ORG_ID }], totalSize: 1 },
      ),
      queryMore: vi.fn(),
      bulk2: {
        job: (_type: string, { id }: { id: string }) => {
          jobsAsked.push(id);
          return {
            // Dated by the org when it last changed state: after its records.
            check: async () => ({
              state: bulkJob.state,
              systemModstamp: new Date(Date.now() - 3 * 60_000).toISOString(),
            }),
            getSuccessfulResults: async () => bulkJob.rows,
            abort: async () => undefined,
          };
        },
      },
    } as unknown as Connection);
    stdout = '';
    stderr = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
      stdout += chunk;
      return true;
    }) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
      stderr += chunk;
      return true;
    }) as never);
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    engine.run = undefined;
  });

  const run = (): Promise<void> =>
    main(argv('--source', 'SRC', '--target', 'TGT', '--object', 'Account', '--json'));

  it('keeps what the run creates in its file as it writes it, says where as it begins, and ends it', async () => {
    engine.run = async (deps, config) => {
      deps.creations?.note('Account', [A1]);
      return answered(config);
    };

    await run();

    const [name] = runFiles();
    const file = join(runsDir(), name);
    const kept = readRunFile(readFileSync(file, 'utf8'));
    expect(kept).toMatchObject({
      sourceOrgId: 'SRC',
      targetOrgId: 'TGT',
      targetOrganizationId: ORG_ID,
      end: { status: 'success' },
      created: [{ objectApiName: 'Account', ids: [A1] }],
    });
    // Said on stderr with --json, the summary alone on stdout.
    expect(stderr).toContain(`run file: ${file}`);
    expect(JSON.parse(stdout).created).toMatchObject({
      runId: kept?.runId,
      runFile: file,
      lastWriteAt: expect.any(String),
    });
  });

  it('keeps what a run that stopped on an error created, and --remove takes it back by the run id', async () => {
    // The command kept what it created in memory, printed once the run
    // returned: a run that threw left nothing to take it back from.
    engine.run = async (deps) => {
      deps.creations?.note('Account', [A1]);
      throw new Error('INVALID_FIELD: the read of Contact was refused');
    };

    await expect(run()).rejects.toThrow('INVALID_FIELD');

    const [name] = runFiles();
    const runId = name.replace(/\.ndjson$/, '');
    expect(readRunFile(readFileSync(join(runsDir(), name), 'utf8'))?.end?.status).toBe('failure');
    expect(stderr).toContain(`--remove ${join(runsDir(), name)} takes it back`);

    org.add('Account', { Id: A1 }, new Date(Date.now() - 60_000).toISOString());
    stdout = '';
    await main(argv('--remove', runId, '--target', 'TGT', '--json'));

    expect(org.deletes.map((d) => d.objectApiName)).toEqual(['Account']);
    expect(org.all('Account')).toEqual([]);
    expect(JSON.parse(stdout)).toMatchObject({ result: { status: 'success', planned: 1 } });
    // What it did is kept beside the file, which the next removal reads.
    expect(existsSync(join(runsDir(), `${runId}.removal.json`))).toBe(true);
    stdout = '';
    await main(argv('--remove', runId, '--target', 'TGT', '--json'));
    expect(JSON.parse(stdout)).toMatchObject({ result: { status: 'success', planned: 0 } });
  });

  it('stops at a Ctrl-C before the next call, ends its file as cancelled, and exits 130', async () => {
    engine.run = async (deps, config) => {
      deps.creations?.note('Account', [A1]);
      process.emit('SIGINT');
      // The run's signal, which stops it before its next object, and its
      // writer before its next call.
      expect(deps.signal?.aborted).toBe(true);
      return answered(config, { status: 'partial', cancelled: true });
    };

    await expect(run()).rejects.toThrow('exit 130');

    const [name] = runFiles();
    expect(readRunFile(readFileSync(join(runsDir(), name), 'utf8'))?.end).toMatchObject({
      status: 'partial',
      cancelled: true,
    });
    expect(stderr).toContain('interrupted: the run stops before its next call');
  });

  it('stops at a SIGTERM, as Jenkins sends on abort or timeout, as at Ctrl-C, and exits 143', async () => {
    engine.run = async (deps, config) => {
      deps.creations?.note('Account', [A1]);
      process.emit('SIGTERM');
      expect(deps.signal?.aborted).toBe(true);
      return answered(config, { status: 'partial', cancelled: true });
    };

    await expect(run()).rejects.toThrow('exit 143');

    const [name] = runFiles();
    expect(readRunFile(readFileSync(join(runsDir(), name), 'utf8'))?.end).toMatchObject({
      cancelled: true,
    });
    expect(process.listenerCount('SIGTERM')).toBe(0);
    expect(process.listenerCount('SIGINT')).toBe(0);
  });

  it('writes nothing to a production org: refused before its run file is begun, and exits 1', async () => {
    // Typed, and the type handed to a gate whose command-line policy never
    // read it: a production target took the run's inserts and updates.
    vi.mocked(makeConn).mockReturnValue({
      query: vi.fn(async (soql: string) =>
        soql.startsWith('SELECT OrganizationType')
          ? { records: [{ OrganizationType: 'Enterprise Edition' }], totalSize: 1 }
          : { records: [{ Id: ORG_ID, IsSandbox: false }], totalSize: 1 },
      ),
    } as unknown as Connection);
    engine.run = async (_deps, config) => answered(config);

    await expect(run()).rejects.toThrow('exit 1');

    expect(runFiles()).toEqual([]);
    expect(stdout).toBe('');
    expect(stderr).toContain(
      'TGT is a production org (its Organization record says IsSandbox false, edition ' +
        'Enterprise Edition): sandforge-sync writes to sandboxes and Developer Edition orgs ' +
        'only. Nothing was written; --dry-run, which only reads, runs against it.',
    );
  });

  it('exits 1 when the target refused every record, and 3 for a partial run with --fail-on-partial', async () => {
    // A run whose records were all refused exited 0, as one that wrote them all.
    engine.run = async (_deps, config) => answered(config, { status: 'failure' });
    await run();
    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
    engine.run = async (_deps, config) => answered(config, { status: 'partial' });
    await run();
    expect(process.exitCode).toBeUndefined();
    await main(
      argv('--source', 'SRC', '--target', 'TGT', '--object', 'Account', '--fail-on-partial'),
    );
    expect(process.exitCode).toBe(3);
    process.exitCode = undefined;
  });

  it('refuses --dry-run=true, the way a pipeline writes --dry-run=$DRY_RUN, before any org is reached', async () => {
    // Dropped without a word, it ran for real.
    vi.mocked(makeConn).mockClear();
    engine.run = async (_deps, config) => answered(config);

    await expect(
      main(argv('--source', 'SRC', '--target', 'TGT', '--object', 'Account', '--dry-run=true')),
    ).rejects.toThrow('exit 2');
    await expect(
      main(argv('--source', 'SRC', '--target', 'TGT', '--object', 'Account', '--dryrun')),
    ).rejects.toThrow('exit 2');

    expect(makeConn).not.toHaveBeenCalled();
    expect(runFiles()).toEqual([]);
    expect(stderr).toContain('"--dry-run=true" is not read: --dry-run takes no value');
  });

  describe('a run killed during a Bulk API job', () => {
    const runId = 'sandforge-sync-killed';
    let file: string;

    beforeEach(() => {
      // As a run killed while its job ran leaves its file: the job opened,
      // never answered, no end.
      mkdirSync(runsDir(), { recursive: true });
      file = join(runsDir(), `${runId}.ndjson`);
      const at = new Date(Date.now() - 5 * 60_000).toISOString();
      writeFileSync(
        file,
        [
          JSON.stringify({
            run: {
              runId,
              configId: 'sandforge-sync',
              configName: 'sandforge-sync',
              sourceOrgId: 'SRC',
              targetOrgId: 'TGT',
              targetOrganizationId: ORG_ID,
              startedAt: at,
              answersNameJobs: true,
            },
          }),
          JSON.stringify({ object: 'Account', created: [A1], at }),
          JSON.stringify({ sending: { object: 'Contact', rows: 250, at } }),
          JSON.stringify({ sending: { object: 'Contact', rows: 250, at, job: JOB } }),
          '',
        ].join('\n'),
      );
      const created = new Date(Date.now() - 4 * 60_000).toISOString();
      org.add('Account', { Id: A1 }, created);
      org.add('Contact', { Id: C1, AccountId: A1 }, created);
      org.add('Contact', { Id: C2, AccountId: A1 }, created);
      bulkJob = {
        state: 'JobComplete',
        rows: [
          { sf__Id: C1, sf__Created: 'true' },
          { sf__Id: C2, sf__Created: 'true' },
        ],
      };
    });

    it('reads the job back by its id from the file alone, and removes its records with the rest', async () => {
      await main(argv('--remove', file, '--target', 'TGT'));

      expect(jobsAsked).toEqual([JOB]);
      expect(stdout).toContain(`Bulk API job ${JOB} (Contact)`);
      expect(org.all('Contact')).toEqual([]);
      expect(org.all('Account')).toEqual([]);
      // The job's answer is in the file now: the next removal asks no more.
      expect(readRunFile(readFileSync(file, 'utf8'))?.jobs).toBeUndefined();
    });

    it('leaves a job still running in the org unanswered, and says the next removal reads it again', async () => {
      bulkJob = { state: 'InProgress', rows: [] };

      // The account stays too: the job's contacts, which stay, hang on it.
      await expect(main(argv('--remove', file, '--target', 'TGT'))).rejects.toThrow('exit 3');

      expect(stdout).toContain('still running in TGT');
      expect(org.all('Contact').map((row) => row.Id)).toEqual([C1, C2]);
      expect(org.all('Account').map((row) => row.Id)).toEqual([A1]);
      expect(readRunFile(readFileSync(file, 'utf8'))?.jobs?.map((job) => job.job)).toEqual([JOB]);
    });

    it('refuses an org that is not the one the run wrote to, reading nothing back', async () => {
      vi.mocked(makeConn).mockReturnValue({
        query: vi.fn(async () => ({ records: [{ Id: '00D000000000009AAA', IsSandbox: true }] })),
      } as unknown as Connection);

      await expect(main(argv('--remove', file, '--target', 'OTHER'))).rejects.toThrow('exit 1');

      expect(stderr).toContain('is not the org the run wrote to');
      expect(jobsAsked).toEqual([]);
      expect(org.deletes).toEqual([]);
    });

    it('refuses the file of a run under another name, deleting nothing', async () => {
      const renamed = join(runsDir(), 'copy.ndjson');
      writeFileSync(renamed, readFileSync(file, 'utf8'));

      await expect(main(argv('--remove', renamed, '--target', 'TGT'))).rejects.toThrow('exit 2');

      expect(stderr).toContain(`is the file of the run ${runId} under another name`);
      expect(org.deletes).toEqual([]);
    });
  });

  it('tells a run file, and a run id, from a summary', () => {
    mkdirSync(runsDir(), { recursive: true });
    const file = join(runsDir(), 'sandforge-sync-1.ndjson');
    writeFileSync(file, `${JSON.stringify({ run: { runId: 'sandforge-sync-1' } })}\n`);
    const summary = join(runsDir(), 'run.json');
    writeFileSync(summary, JSON.stringify({ tool: 'sandforge-sync' }, null, 2));

    expect(runFileOf(file)).toBe(file);
    expect(runFileOf('sandforge-sync-1')).toBe(file);
    expect(runFileOf(summary)).toBeUndefined();
    expect(runFileOf('sandforge-sync-unknown')).toBeUndefined();
    expect(runFileOf('../sandforge-sync-1')).toBeUndefined();
  });
});
