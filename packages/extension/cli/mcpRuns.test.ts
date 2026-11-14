import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HOLD_SECONDS_DEFAULT,
  LineTail,
  McpRuns,
  RUN_HANDLE,
  TAIL_LINES,
  holdMsOf,
  isRunHandle,
  readRunSummary,
  runsDirOf,
  stampedId,
  summaryPathOf,
  type RunLauncher,
} from './mcpRuns.js';
import type { CommandRun } from './scriptRunner.js';

/*
 * The runs of the MCP server that go on past their call: held a while, then
 * handed back under a handle that follows them, stops them, and reads their
 * answer once they have ended; and what a later server reads of them on disk.
 */

let journalDir: string;
let dir: string;

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcp-runs-'));
  dir = runsDirOf(journalDir);
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(journalDir, { recursive: true, force: true });
});

/** A script that runs until the test ends it: what it was told, and how to end it. */
function script() {
  let end: (ran: CommandRun) => void = () => undefined;
  const told: { signal?: AbortSignal; onStderr?: (text: string) => void } = {};
  const launch: RunLauncher = ({ signal, onStderr }) => {
    told.signal = signal;
    told.onStderr = onStderr;
    return new Promise<CommandRun>((resolve) => {
      end = resolve;
      signal.addEventListener('abort', () =>
        resolve({ code: 130, stdout: '', stderr: 'interrupted' }),
      );
    });
  };
  return { launch, told, end: (ran: CommandRun) => end(ran) };
}

/** A registry of runs kept under the test's journal folder, holding its calls `holdMs`. */
function registry(holdMs = 10, now?: () => Date) {
  return new McpRuns<string>({ dir, holdMs, ...(now ? { now } : {}) });
}

describe('how long a call holds its script', () => {
  it('is 45 seconds unless SANDFORGE_MCP_HOLD_SECONDS says 0 to 55', () => {
    expect(HOLD_SECONDS_DEFAULT).toBe(45);
    expect(holdMsOf({})).toBe(45_000);
    expect(holdMsOf({ SANDFORGE_MCP_HOLD_SECONDS: '5' })).toBe(5_000);
    expect(holdMsOf({ SANDFORGE_MCP_HOLD_SECONDS: ' 0 ' })).toBe(0);
    expect(holdMsOf({ SANDFORGE_MCP_HOLD_SECONDS: '55' })).toBe(55_000);
    expect(holdMsOf({ SANDFORGE_MCP_HOLD_SECONDS: '2.5' })).toBe(2_500);
    // Past the minute a client gives a call, or no number: the default.
    for (const said of ['56', '600', '-1', 'soon', '']) {
      expect(holdMsOf({ SANDFORGE_MCP_HOLD_SECONDS: said }), said).toBe(45_000);
    }
  });
});

describe('the handle of a run', () => {
  it('is made of when it started and four random characters, and nothing else makes a path', () => {
    const handle = stampedId('mr', new Date('2026-11-14T19:00:12.345Z'));

    expect(handle).toMatch(/^mr-20261114-190012-[a-z0-9]{4}$/);
    expect(handle).toMatch(RUN_HANDLE);
    expect(stampedId('co', new Date('2026-11-14T19:00:12.345Z'))).toMatch(
      /^co-20261114-190012-[a-z0-9]{4}$/,
    );
    for (const given of ['../mr-20261114-190012-abcd', 'mr-20261114-190012-ABCD', 'mr-1']) {
      expect(isRunHandle(given), given).toBe(false);
      expect(() => summaryPathOf(dir, given)).toThrow('Not the handle of a run');
    }
    expect(summaryPathOf(dir, handle)).toBe(join(dir, `${handle}.json`));
  });
});

describe('the last lines a script said', () => {
  it('keeps the last lines as they come a piece at a time, the one still being said last', () => {
    const tail = new LineTail(3);
    tail.push('one\r\ntw');
    tail.push('o\nthree\nfour\nfi');

    expect(tail.lines()).toEqual(['three', 'four', 'fi']);
    tail.push('ve\n');
    expect(tail.lines()).toEqual(['three', 'four', 'five']);
    expect(TAIL_LINES).toBe(20);
  });
});

describe('the summary a clone rewrites as it goes', () => {
  it('says how far the run is, its journal, and whether it runs, ended, stopped or failed', async () => {
    const path = join(journalDir, 'summary.json');
    const result = {
      successCount: 40,
      updatedCount: 1,
      linkedCount: 2,
      failedCount: 3,
      createdByObject: [{ objectApiName: 'Account' }, { objectApiName: 'Contact' }],
    };
    await writeFile(path, JSON.stringify({ running: true, journal: '/j.ndjson', result }));

    expect(await readRunSummary(path)).toEqual({
      state: 'running',
      journal: '/j.ndjson',
      written: 43,
      failed: 3,
      objectsWritten: 2,
    });
    await writeFile(path, JSON.stringify({ interrupted: true, result }));
    expect((await readRunSummary(path))?.state).toBe('interrupted');
    await writeFile(path, JSON.stringify({ error: 'socket hang up', result }));
    expect((await readRunSummary(path))?.state).toBe('failed');
    await writeFile(path, JSON.stringify({ finishedAt: '2026-11-14T19:30:00.000Z', result }));
    expect(await readRunSummary(path)).toMatchObject({
      state: 'ended',
      finishedAt: '2026-11-14T19:30:00.000Z',
    });
    // A count that is no count is read as none, not as the run's failure to say.
    await writeFile(path, JSON.stringify({ running: true, result: { successCount: 'many' } }));
    expect(await readRunSummary(path)).toMatchObject({ written: 0, objectsWritten: 0 });
  });

  it('says nothing of a summary not written yet, or one that does not read as JSON', async () => {
    const path = join(journalDir, 'summary.json');
    expect(await readRunSummary(path)).toBeUndefined();
    await writeFile(path, '{"running": tr');
    expect(await readRunSummary(path)).toBeUndefined();
    await writeFile(path, '[1, 2]');
    expect(await readRunSummary(path)).toBeUndefined();
  });
});

describe('a run of a tool', () => {
  it('answers its call when its script ends within the hold, and is not kept', async () => {
    const runs = registry(1_000);
    const run = runs.start({ handle: runs.newHandle(), tool: 'seed_run' }, async () => ({
      code: 0,
      stdout: '{}',
      stderr: 'done\n',
    }));

    expect(runs.get(run.handle)).toBe(run);
    expect(await runs.hold(run)).toEqual({ code: 0, stdout: '{}', stderr: 'done\n' });
    expect(runs.get(run.handle)).toBeUndefined();
    expect(await readdir(journalDir)).toEqual([]);
  });

  it('is handed back once the hold is over: kept with what a later server reads, its owner’s alone', async () => {
    const runs = registry(10);
    const { launch, told, end } = script();
    const handle = runs.newHandle();
    const summary = runs.summaryPathOf(handle);
    const run = runs.start(
      {
        handle,
        tool: 'clone_org',
        target: 'TGT',
        plan: 'co-20261114-185900-abcd',
        summary,
        expectedSeconds: 1_200,
      },
      launch,
    );

    expect(await runs.hold(run)).toBeUndefined();
    await runs.handBack(run);
    expect(told.signal?.aborted).toBe(false);

    expect(runs.get(handle)).toBe(run);
    const meta = JSON.parse(await readFile(join(dir, `${handle}.meta.json`), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(meta).toMatchObject({
      handle,
      tool: 'clone_org',
      target: 'TGT',
      plan: 'co-20261114-185900-abcd',
      summary,
      expectedSeconds: 1_200,
    });
    expect(Date.parse(String(meta['startedAt']))).not.toBeNaN();
    if (process.platform !== 'win32') {
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
      expect((await stat(join(dir, `${handle}.meta.json`))).mode & 0o777).toBe(0o600);
    }

    end({ code: 0, stdout: '{"result":{}}', stderr: '' });
    expect(await run.ended).toMatchObject({ code: 0 });
    // Ended, it is kept for its handle until the server ends.
    expect(runs.get(handle)).toBe(run);
    expect(run.running).toBe(false);
  });

  it('says how far it is: its time against its plan’s, its summary so far, the last lines of its script', async () => {
    let clock = Date.parse('2026-11-14T19:00:00.000Z');
    const runs = registry(10, () => new Date(clock));
    const { launch, told } = script();
    const handle = runs.newHandle();
    const summary = runs.summaryPathOf(handle);
    const run = runs.start(
      { handle, tool: 'clone_org', target: 'TGT', summary, expectedSeconds: 600 },
      launch,
    );
    await runs.hold(run);
    await runs.handBack(run);

    expect(await runs.progress(run)).toEqual({ elapsedSeconds: 0, expectedSeconds: 600, tail: [] });

    clock += 95_000;
    for (let line = 1; line <= 25; line++) told.onStderr?.(`line ${line}\n`);
    await writeFile(
      summary,
      JSON.stringify({ running: true, journal: '/runs/j.ndjson', result: { successCount: 7 } }),
    );
    const progress = await runs.progress(run);

    expect(progress.elapsedSeconds).toBe(95);
    expect(progress.summary).toMatchObject({
      state: 'running',
      written: 7,
      journal: '/runs/j.ndjson',
    });
    expect(progress.tail).toHaveLength(20);
    expect(progress.tail[0]).toBe('line 6');
    expect(progress.tail[19]).toBe('line 25');
    expect(runs.busyWith('TGT')).toBe(run);
    expect(runs.busyWith('OTHER')).toBeUndefined();
    expect(await runs.underWayWith('/runs/j.ndjson')).toBe(run);
    expect(await runs.underWayWith('/runs/other.ndjson')).toBeUndefined();
    run.stop();
    await run.ended;
    expect(runs.busyWith('TGT')).toBeUndefined();
    expect(await runs.underWayWith('/runs/j.ndjson')).toBeUndefined();
  });

  it('is stopped as Ctrl-C stops it, through the abort of its own', async () => {
    const runs = registry(10);
    const { launch, told } = script();
    const run = runs.start({ handle: runs.newHandle(), tool: 'clone_org' }, launch);
    await runs.hold(run);
    await runs.handBack(run);

    run.stop();

    expect(told.signal?.aborted).toBe(true);
    expect(await run.ended).toEqual({ code: 130, stdout: '', stderr: 'interrupted' });
  });

  it('is waited for as run_status waits, 50 seconds at most whatever it is asked, and no time for no number', async () => {
    vi.useFakeTimers();
    const runs = registry(10);
    const { launch, end } = script();
    const run = runs.start({ handle: runs.newHandle(), tool: 'clone_org' }, launch);
    let said: CommandRun | undefined | 'waiting' = 'waiting';
    void runs.waitFor(run, 120).then((ran) => {
      said = ran;
    });

    await vi.advanceTimersByTimeAsync(49_999);
    expect(said).toBe('waiting');
    await vi.advanceTimersByTimeAsync(1);
    expect(said).toBeUndefined();

    for (const seconds of [-5, Number.NaN]) {
      const now = runs.waitFor(run, seconds);
      await vi.advanceTimersByTimeAsync(0);
      expect(await now, String(seconds)).toBeUndefined();
    }
    const ended = runs.waitFor(run, 30);
    end({ code: 0, stdout: '', stderr: '' });
    expect(await ended).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  it('makes the answer its tool gives of it once, whoever asks for it after it ended', async () => {
    const runs = registry(10);
    const { launch, end } = script();
    const run = runs.start({ handle: runs.newHandle(), tool: 'clone_org' }, launch);
    const make = vi.fn(async (ran: CommandRun) => `answered ${ran.code}`);
    expect(await runs.hold(run)).toBeUndefined();

    const first = run.settled(make);
    end({ code: 3, stdout: '', stderr: '' });

    expect(await first).toBe('answered 3');
    expect(await run.settled(make)).toBe('answered 3');
    expect(make).toHaveBeenCalledTimes(1);
  });

  it('ends on a failure, said, when its script cannot be started', async () => {
    const runs = registry(1_000);
    const run = runs.start({ handle: runs.newHandle(), tool: 'clone_org' }, () => {
      throw new Error('spawn EACCES');
    });

    expect(await runs.hold(run)).toEqual({
      code: 1,
      stdout: '',
      stderr: 'The script could not be started: spawn EACCES',
    });
  });

  it('refuses a handle that is not one, before it is made a path', () => {
    const runs = registry();
    expect(() => runs.start({ handle: '../escape', tool: 'clone_org' }, script().launch)).toThrow(
      'Not the handle of a run',
    );
    expect(runs.get('../escape')).toBeUndefined();
  });
});

describe('the end of the server', () => {
  it('stops every run still running and settles once each has ended', async () => {
    const runs = registry(10);
    const first = script();
    const second = script();
    const a = runs.start({ handle: runs.newHandle(), tool: 'clone_org' }, first.launch);
    const b = runs.start({ handle: runs.newHandle(), tool: 'run_remove' }, second.launch);
    await runs.hold(a);
    await runs.handBack(a);

    await runs.stopAll();

    expect(first.told.signal?.aborted).toBe(true);
    expect(second.told.signal?.aborted).toBe(true);
    expect(a.running).toBe(false);
    expect(b.running).toBe(false);
  });
});

describe('a run another server handed back', () => {
  it('is read off the disk, what it was and what its summary says, by a server that never held it', async () => {
    const first = registry(10);
    const { launch } = script();
    const handle = first.newHandle();
    const summary = first.summaryPathOf(handle);
    const run = first.start({ handle, tool: 'clone_org', target: 'TGT', summary }, launch);
    await first.hold(run);
    await first.handBack(run);
    await writeFile(
      summary,
      JSON.stringify({ interrupted: true, journal: '/runs/j.ndjson', result: { successCount: 4 } }),
    );
    run.stop();
    await run.ended;

    const later = registry(10);

    expect(later.get(handle)).toBeUndefined();
    expect(await later.readOnDisk(handle)).toMatchObject({
      meta: { handle, tool: 'clone_org', target: 'TGT', summary },
      summary: { state: 'interrupted', journal: '/runs/j.ndjson', written: 4 },
    });
    expect(await later.readOnDisk(stampedId('mr'))).toBeUndefined();
    expect(await later.readOnDisk('../../etc/passwd')).toBeUndefined();
  });

  it('is forgotten a day on once its journal is gone, or it named none; kept while its journal is there', async () => {
    // On the machine's clock: what a file was last written at is read on it.
    const now = Date.now();
    const runs = registry(10, () => new Date(now));
    const journal = join(journalDir, 'kept.ndjson');
    await writeFile(journal, '');
    const handBack = async (summary: Record<string, unknown> | undefined): Promise<string> => {
      const handle = runs.newHandle();
      const path = runs.summaryPathOf(handle);
      const run = runs.start({ handle, tool: 'clone_org', summary: path }, async () => ({
        code: 0,
        stdout: '',
        stderr: '',
      }));
      await runs.handBack(run);
      await run.ended;
      if (summary) await writeFile(path, JSON.stringify(summary));
      return handle;
    };
    const kept = await handBack({ journal });
    const gone = await handBack({ journal: join(journalDir, 'gone.ndjson') });
    const none = await handBack(undefined);
    const recent = await handBack({ journal: join(journalDir, 'gone.ndjson') });
    const dayAgo = new Date(now - 24 * 60 * 60_000 - 1_000);
    for (const handle of [kept, gone, none]) {
      await utimes(join(dir, `${handle}.meta.json`), dayAgo, dayAgo);
    }
    // A server that holds none of them; the one that does keeps each whatever its age.
    const later = registry(10, () => new Date(now));

    expect(await later.sweep()).toBe(2);
    const left = await readdir(dir);
    expect(left).toContain(`${kept}.meta.json`);
    expect(left).toContain(`${recent}.meta.json`);
    expect(left).not.toContain(`${gone}.meta.json`);
    expect(left).not.toContain(`${gone}.json`);
    expect(left).not.toContain(`${none}.meta.json`);
    expect(await runs.sweep()).toBe(0);
    await rm(dir, { recursive: true });
    expect(await later.sweep()).toBe(0);
  });
});
