import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PipelineHistoryEntry } from '@sandforge/shared';
import {
  CLI_HISTORY_LIMIT,
  cliHistoryFileOf,
  cliRunHistory,
  recordCliRun,
} from './cliRunHistory.js';
import { pipelineFolderOf } from './PipelineRunLock.js';

const PIPELINE = '3f1c2b9e-6a0d-4c8e-9b7a-2d4f6e8a1c3b';

function run(n: number, overrides: Partial<PipelineHistoryEntry> = {}): PipelineHistoryEntry {
  return {
    runId: `run-${n}`,
    pipelineId: PIPELINE,
    pipelineName: 'Nightly reset',
    status: 'completed',
    triggeredBy: 'schedule',
    startTime: new Date(Date.UTC(2026, 10, 1, 2, 0) + n * 86_400_000).toISOString(),
    duration: 1_000,
    stepCount: 2,
    errorCount: 0,
    steps: [
      {
        stepName: 'Wait',
        stepType: 'delay',
        status: 'completed',
        duration: 0,
        summary: 'Waited 0 s',
      },
      {
        stepName: 'Go?',
        stepType: 'approval',
        status: 'completed',
        approval: { decision: 'approved', via: 'commandLine', at: '2026-11-01T02:00:01.000Z' },
      },
    ],
    ...overrides,
  };
}

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sandforge-cli-history-'));
  made.push(dir);
  return join(dir, 'pipelines');
}

describe('the command line history of a pipeline', () => {
  it('keeps a run in the pipeline folder, its owner’s alone, and lists it marked as a command line run', () => {
    const pipelines = root();
    recordCliRun(pipelines, PIPELINE, run(1));

    const file = cliHistoryFileOf(pipelines, PIPELINE);
    expect(file).toBe(join(pipelines, PIPELINE, 'history.json'));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(pipelineFolderOf(pipelines, PIPELINE)).mode & 0o777).toBe(0o700);

    const listed = cliRunHistory(pipelines, vi.fn()).read();
    expect(listed).toEqual([
      {
        ...run(1),
        ranFrom: 'commandLine',
        timestamp: Date.parse(run(1).startTime),
      },
    ]);
  });

  it('keeps the newest runs past the limit, newest first, and a run id once', () => {
    const pipelines = root();
    for (let n = 0; n < CLI_HISTORY_LIMIT + 5; n += 1) recordCliRun(pipelines, PIPELINE, run(n));
    const recorded = recordCliRun(
      pipelines,
      PIPELINE,
      run(CLI_HISTORY_LIMIT + 4, { status: 'failed' }),
    );

    expect(recorded).toEqual({ kept: CLI_HISTORY_LIMIT });
    const listed = cliRunHistory(pipelines, vi.fn()).read();
    expect(listed).toHaveLength(CLI_HISTORY_LIMIT);
    expect(listed[0]).toMatchObject({ runId: `run-${CLI_HISTORY_LIMIT + 4}`, status: 'failed' });
    expect(listed.at(-1)?.runId).toBe('run-5');
  });

  it('never keeps what an entry carries besides the run, such as the definition with its values', () => {
    const pipelines = root();
    const withDefinition = {
      ...run(1),
      pipeline: { variables: [{ name: 'token', type: 'secret', defaultValue: 'hunter2' }] },
    } as PipelineHistoryEntry;

    recordCliRun(pipelines, PIPELINE, withDefinition);

    expect(readFileSync(cliHistoryFileOf(pipelines, PIPELINE), 'utf8')).not.toContain('hunter2');
  });

  it('lists the runs of every pipeline of the folder together, newest first', () => {
    const pipelines = root();
    recordCliRun(pipelines, PIPELINE, run(1));
    recordCliRun(pipelines, 'other', run(3, { pipelineId: 'other', runId: 'other-3' }));
    recordCliRun(pipelines, PIPELINE, run(2));

    expect(
      cliRunHistory(pipelines, vi.fn())
        .read()
        .map((entry) => entry.runId),
    ).toEqual(['other-3', 'run-2', 'run-1']);
  });

  it('says a history that does not read once, lists the others, and says it again once it changed', () => {
    const pipelines = root();
    recordCliRun(pipelines, PIPELINE, run(1));
    mkdirSync(join(pipelines, 'broken'), { recursive: true });
    const broken = join(pipelines, 'broken', 'history.json');
    writeFileSync(broken, '{"sandforgePipelineHistory": 1, "entries": [');
    const log = vi.fn();
    const reader = cliRunHistory(pipelines, log);

    expect(reader.read().map((entry) => entry.runId)).toEqual(['run-1']);
    expect(reader.read().map((entry) => entry.runId)).toEqual(['run-1']);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain(
      `pipeline history ${broken} is not listed: it is not JSON`,
    );

    writeFileSync(broken, '{"sandforgePipelineHistory": 2, "entries": []}');
    reader.read();
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[1]?.[0]).toContain('a later release of SandForge wrote it (version 2)');
  });

  it('lists the runs of a history that read and says how many did not', () => {
    const pipelines = root();
    mkdirSync(join(pipelines, PIPELINE), { recursive: true });
    writeFileSync(
      cliHistoryFileOf(pipelines, PIPELINE),
      JSON.stringify({ sandforgePipelineHistory: 1, entries: [run(1), { runId: 'half' }] }),
    );
    const log = vi.fn();

    expect(
      cliRunHistory(pipelines, log)
        .read()
        .map((entry) => entry.runId),
    ).toEqual(['run-1']);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('1 of its runs do not read'));
  });

  it('lists nothing, and says nothing, where no pipeline ran from the command line', () => {
    const log = vi.fn();
    expect(cliRunHistory(join(root(), 'missing'), log).read()).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });

  it('puts a history that does not read aside before it records, rather than writing over it', () => {
    const pipelines = root();
    mkdirSync(join(pipelines, PIPELINE), { recursive: true });
    writeFileSync(cliHistoryFileOf(pipelines, PIPELINE), 'not json');

    const recorded = recordCliRun(pipelines, PIPELINE, run(1));

    expect(recorded.setAside).toMatch(/history\.json\.unreadable-\d+$/);
    expect(readFileSync(recorded.setAside!, 'utf8')).toBe('not json');
    expect(
      cliRunHistory(pipelines, vi.fn())
        .read()
        .map((entry) => entry.runId),
    ).toEqual(['run-1']);
    expect(readdirSync(join(pipelines, PIPELINE)).filter((name) => name.endsWith('.tmp'))).toEqual(
      [],
    );
  });

  it('refuses to record an entry the History tab could not list, and writes nothing', () => {
    const pipelines = root();
    expect(() =>
      recordCliRun(pipelines, PIPELINE, { ...run(1), status: 'missed' } as PipelineHistoryEntry),
    ).toThrow(/The run was not recorded: status/);
    expect(existsSync(cliHistoryFileOf(pipelines, PIPELINE))).toBe(false);
  });
});
