import { describe, it, expect, vi } from 'vitest';
import * as path from 'node:path';
import type { Connection } from 'jsforce';
import type { BulkApiExecutor } from '../../core/engine/BulkApiExecutor';
import type { BulkApiManager } from '../../core/engine/BulkApiManager';
import { BulkDataWriter, syncWriterCalls } from './BulkDataWriter';
import {
  SYNC_RUNS_DIR,
  SyncRunCreations,
  createdCount,
  readRunFile,
  syncRemovalPlan,
  type SyncRunCreationsDeps,
} from './SyncRunCreations';

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;
const JOB = fakeId('750', 1);
const JOB2 = fakeId('750', 2);

const STORAGE = path.join(path.sep, 'storage');
const DIR = path.join(STORAGE, SYNC_RUNS_DIR);

/** A disk in memory, keyed as the platform writes paths. */
function memoryDisk(overrides: Partial<SyncRunCreationsDeps> = {}) {
  const files = new Map<string, string>();
  const deps: SyncRunCreationsDeps = {
    storagePath: STORAGE,
    readFile: vi.fn(async (filePath: string) => {
      const text = files.get(filePath);
      if (text === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return text;
    }),
    writeFile: vi.fn(async (filePath: string, content: string) => {
      files.set(filePath, content);
    }),
    appendFile: vi.fn(async (filePath: string, content: string) => {
      files.set(filePath, (files.get(filePath) ?? '') + content);
    }),
    rename: vi.fn(async (from: string, to: string) => {
      const text = files.get(from);
      if (text === undefined) throw new Error('ENOENT');
      files.set(to, text);
      files.delete(from);
    }),
    mkdir: vi.fn(async () => undefined),
    rm: vi.fn(async (filePath: string) => {
      files.delete(filePath);
    }),
    listFiles: vi.fn(async (dirPath: string) =>
      [...files]
        .filter(([filePath]) => path.dirname(filePath) === dirPath)
        .map(([filePath, text]) => ({ name: path.basename(filePath), size: text.length })),
    ),
    ...overrides,
  };
  return { files, deps };
}

const start = (runId: string, startedAt = '2026-10-14T08:00:00.000Z') => ({
  runId,
  configId: 'cfg-1',
  configName: 'Accounts',
  sourceOrgId: 'src-org',
  targetOrgId: 'tgt-org',
  startedAt,
});

describe('SyncRunCreations — what a run created, kept as it writes it', () => {
  it('writes nothing for a run that creates nothing', async () => {
    const { files, deps } = memoryDisk();
    const recorder = new SyncRunCreations(deps).recorder(start('run-1'));

    recorder.note('Account', []);
    await recorder.end({ status: 'success' });

    expect(await recorder.flush()).toBeUndefined();
    expect(files.size).toBe(0);
  });

  it('writes each write as it is noted, so a run a closed window stopped stays removable', async () => {
    const { files, deps } = memoryDisk();
    const store = new SyncRunCreations(deps);
    const recorder = store.recorder(start('run-1'));

    recorder.note('Account', [fakeId('001', 1), fakeId('001', 2)]);
    await recorder.flush();

    // No end line: the run never ended, and what it created is there.
    expect(files.get(path.join(DIR, 'run-1.ndjson'))?.split('\n').filter(Boolean)).toHaveLength(2);
    expect(await store.get('run-1')).toEqual({
      ...start('run-1'),
      lastWrittenAt: expect.any(String),
      firstWrittenAt: expect.any(String),
      lastWriteAt: expect.any(String),
      created: [{ objectApiName: 'Account', ids: [fakeId('001', 1), fakeId('001', 2)] }],
    });
  });

  it('reads back each object once, in the order first written, each id once, and how the run ended', async () => {
    const { deps } = memoryDisk();
    const store = new SyncRunCreations(deps);
    const recorder = store.recorder(start('run-1'));

    recorder.note('Account', [fakeId('001', 1)]);
    recorder.note('Contact', [fakeId('003', 1)]);
    // The same record by its 15-character id: kept once.
    recorder.note('Account', [fakeId('001', 2), fakeId('001', 1).slice(0, 15)]);
    recorder.note('ContentDocument', [fakeId('069', 1)]);
    await recorder.end({ status: 'partial', cancelled: true });

    const run = await store.get('run-1');
    expect(run?.created).toEqual([
      { objectApiName: 'Account', ids: [fakeId('001', 1), fakeId('001', 2)] },
      { objectApiName: 'Contact', ids: [fakeId('003', 1)] },
      { objectApiName: 'ContentDocument', ids: [fakeId('069', 1)] },
    ]);
    expect(run?.end).toEqual({ at: expect.any(String), status: 'partial', cancelled: true });
    expect(run && createdCount(run)).toBe(4);
  });

  it('keeps no value that is not an id, nor an object name that is not one', async () => {
    const { deps } = memoryDisk();
    const store = new SyncRunCreations(deps);
    const recorder = store.recorder(start('run-1'));

    recorder.note('Account', ["x' OR Id != '", fakeId('001', 1)]);
    recorder.note('Account; DELETE', [fakeId('001', 2)]);
    await recorder.flush();

    expect((await store.get('run-1'))?.created).toEqual([
      { objectApiName: 'Account', ids: [fakeId('001', 1)] },
    ]);
  });

  it('names the call a run had under way when its window closed, and none once the call answered', async () => {
    const { deps } = memoryDisk();
    const store = new SyncRunCreations(deps);
    const cut = store.recorder(start('run-cut'));
    cut.sending?.('Account', 2);
    cut.answered?.('Account', [fakeId('001', 1), fakeId('001', 2)]);
    cut.sending?.('Contact', 10_000);
    await cut.flush();
    const answered = store.recorder(start('run-answered'));
    answered.sending?.('Contact', 200);
    // A call that created nothing answers it all the same.
    answered.answered?.('Contact', []);
    await answered.flush();

    const run = await store.get('run-cut');
    expect(run?.inFlight).toEqual({
      objectApiName: 'Contact',
      rows: 10_000,
      at: expect.any(String),
    });
    expect(run?.created).toEqual([
      { objectApiName: 'Account', ids: [fakeId('001', 1), fakeId('001', 2)] },
    ]);
    const other = await store.get('run-answered');
    expect(other?.inFlight).toBeUndefined();
    expect(other?.created).toEqual([]);
    // It wrote nothing, so it has no date of a last write.
    expect(other?.lastWrittenAt).toBeUndefined();
  });

  it('dates its last write by the records it wrote again after its last creation, creating nothing more', () => {
    // The accounts of a cycle are given their contacts' copies once the
    // contacts are in: dated by the creation alone, the removal read them as
    // changed since the run, and kept them.
    const text = [
      JSON.stringify({ run: start('run-cycle') }),
      JSON.stringify({
        object: 'Account',
        created: [fakeId('001', 1)],
        at: '2026-10-14T08:00:05.000Z',
      }),
      JSON.stringify({
        object: 'Contact',
        created: [fakeId('003', 1)],
        at: '2026-10-14T08:00:09.000Z',
      }),
      JSON.stringify({ touched: { object: 'Account', rows: 1, at: '2026-10-14T08:00:40.000Z' } }),
      // Cut short by a closed window: left out.
      '{"touched": {"object": "Acc',
    ].join('\n');

    const run = readRunFile(text);

    expect(run?.lastWrittenAt).toBe('2026-10-14T08:00:40.000Z');
    expect(run?.created).toEqual([
      { objectApiName: 'Account', ids: [fakeId('001', 1)] },
      { objectApiName: 'Contact', ids: [fakeId('003', 1)] },
    ]);
  });

  it('writes a line for the records a run wrote again, which a later read dates its last write by', async () => {
    const { deps } = memoryDisk();
    const store = new SyncRunCreations(deps);
    const recorder = store.recorder(start('run-touched'));
    recorder.note('Account', [fakeId('001', 1)], '2026-10-14T08:00:05.000Z');
    recorder.touched?.('Account', 1);
    recorder.touched?.('Account', 0);
    await recorder.flush();

    const run = await store.get('run-touched');

    expect(Date.parse(run?.lastWrittenAt ?? '')).toBeGreaterThan(
      Date.parse('2026-10-14T08:00:05.000Z'),
    );
    expect(createdCount(run ?? { created: [] })).toBe(1);
  });

  it('dates its first write by its first call, an update before anything was created included', () => {
    // The sweep of its removal starts there: the tasks the target's flows
    // opened on the accounts it updated first were left out of a window that
    // began at its first creation.
    const text = [
      JSON.stringify({ run: start('run-update-first') }),
      JSON.stringify({ writing: { object: 'Account', rows: 3, at: '2026-10-14T08:00:02.000Z' } }),
      JSON.stringify({ sending: { object: 'Contact', rows: 2, at: '2026-10-14T08:00:06.000Z' } }),
      JSON.stringify({
        object: 'Contact',
        created: [fakeId('003', 1)],
        at: '2026-10-14T08:00:09.000Z',
      }),
    ].join('\n');

    const run = readRunFile(text);

    expect(run?.firstWrittenAt).toBe('2026-10-14T08:00:02.000Z');
    // An update names no call under way, and creates nothing of the run's.
    expect(run?.inFlight).toBeUndefined();
    expect(run?.created).toEqual([{ objectApiName: 'Contact', ids: [fakeId('003', 1)] }]);
    expect(run?.lastWrittenAt).toBe('2026-10-14T08:00:09.000Z');
    // A run kept before lines dated its updates: its first call, or what it first created.
    expect(
      readRunFile(
        text
          .split('\n')
          .filter((l) => !l.includes('writing'))
          .join('\n'),
      ),
    ).toEqual(expect.objectContaining({ firstWrittenAt: '2026-10-14T08:00:06.000Z' }));
  });

  it('writes the line of a first write that creates nothing with its file’s first line, each later one as it comes, and no file for a run that only updates', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { files, deps } = memoryDisk();
      const store = new SyncRunCreations(deps);
      vi.setSystemTime(new Date('2026-10-14T08:00:02.000Z'));
      const updating = store.recorder(start('run-updates'));
      updating.writing?.('Account', 3);
      await updating.end({ status: 'success' });
      expect(files.size).toBe(0);

      const recorder = store.recorder(start('run-update-first'));
      recorder.writing?.('Account', 3);
      vi.setSystemTime(new Date('2026-10-14T08:00:05.000Z'));
      recorder.writing?.('Account', 2);
      vi.setSystemTime(new Date('2026-10-14T08:00:06.000Z'));
      recorder.sending?.('Contact', 2);
      recorder.answered?.('Contact', [fakeId('003', 1)]);
      vi.setSystemTime(new Date('2026-10-14T08:00:20.000Z'));
      // An update after the file began is no first write, but it is the
      // run's last: the sweep of its removal stops a minute after it.
      recorder.writing?.('Contact', 1);
      await recorder.end({ status: 'success' });

      const lines = [...files.values()][0].trim().split('\n');
      // The update before the file began, after the first, is earlier than
      // the line that began it: not kept.
      expect(lines.filter((line) => line.includes('"writing"'))).toEqual([
        JSON.stringify({ writing: { object: 'Account', rows: 3, at: '2026-10-14T08:00:02.000Z' } }),
        JSON.stringify({ writing: { object: 'Contact', rows: 1, at: '2026-10-14T08:00:20.000Z' } }),
      ]);
      expect(lines[1]).toContain('"writing"');
      const run = await store.get('run-update-first');
      expect(run?.firstWrittenAt).toBe('2026-10-14T08:00:02.000Z');
      expect(run?.lastWriteAt).toBe('2026-10-14T08:00:20.000Z');
      expect(run?.lastWrittenAt).toBe('2026-10-14T08:00:06.000Z');
      expect(run?.created).toEqual([{ objectApiName: 'Contact', ids: [fakeId('003', 1)] }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('names no call under way for a run that ended', async () => {
    const { deps } = memoryDisk();
    const store = new SyncRunCreations(deps);
    const recorder = store.recorder(start('run-1'));
    recorder.note('Account', [fakeId('001', 1)]);
    recorder.sending?.('Contact', 5);
    await recorder.end({ status: 'partial', cancelled: true });

    expect((await store.get('run-1'))?.inFlight).toBeUndefined();
  });

  it('keeps the Bulk API job of a write that failed after the org opened it, the run ended in failure', async () => {
    // The job ran on to its end in the target while the run failed polling
    // it: the run's end, written all the same, left the job's records with
    // no line of them and its removal took none of them.
    const { deps } = memoryDisk();
    const store = new SyncRunCreations(deps);
    const recorder = store.recorder(start('run-failed'));
    const bulkExecutor = {
      shouldUseBulkApi: () => true,
      executeBulk: vi.fn(async (bulk: { onOpened?: (jobId: string) => void }) => {
        bulk.onOpened?.(JOB);
        throw new Error('INVALID_SESSION_ID: the poll of the job was refused');
      }),
    };
    const writer = new BulkDataWriter({
      connection: {} as unknown as Connection,
      bulkExecutor: bulkExecutor as unknown as BulkApiExecutor,
      bulkManager: {} as unknown as BulkApiManager,
      retryConfig: { maxRetries: 0, initialDelay: 0, jitter: false },
      onProgress: vi.fn(),
      log: vi.fn(),
      calls: syncWriterCalls(recorder),
    });
    recorder.note('Account', [fakeId('001', 1)]);

    await expect(
      writer.insert(
        'Contact',
        Array.from({ length: 300 }, (_, n) => ({ LastName: `C${n}` })),
        200,
      ),
    ).rejects.toThrow('INVALID_SESSION_ID');
    await recorder.end({ status: 'failure' });

    const run = await store.get('run-failed');
    expect(run?.end?.status).toBe('failure');
    expect(run?.jobs).toEqual([
      { objectApiName: 'Contact', rows: 300, at: expect.any(String), job: JOB },
    ]);
    expect(run?.created).toEqual([{ objectApiName: 'Account', ids: [fakeId('001', 1)] }]);
  });

  it('keeps every job no line answers, whatever call of the same object came after it', () => {
    const text = [
      JSON.stringify({ run: { ...start('run-jobs'), answersNameJobs: true } }),
      JSON.stringify({ sending: { object: 'Contact', rows: 300, at: '2026-10-14T08:00:01.000Z' } }),
      JSON.stringify({
        sending: { object: 'Contact', rows: 300, at: '2026-10-14T08:00:02.000Z', job: JOB },
      }),
      // The job failed while it was polled; a REST call of the same object,
      // and its answer, which answers it and not the job.
      JSON.stringify({ sending: { object: 'Contact', rows: 2, at: '2026-10-14T08:00:30.000Z' } }),
      JSON.stringify({
        object: 'Contact',
        created: [fakeId('003', 1)],
        at: '2026-10-14T08:00:31.000Z',
      }),
      JSON.stringify({ sending: { object: 'Lead', rows: 400, at: '2026-10-14T08:00:40.000Z' } }),
      JSON.stringify({
        sending: { object: 'Lead', rows: 400, at: '2026-10-14T08:00:41.000Z', job: JOB2 },
      }),
      JSON.stringify({
        object: 'Lead',
        created: [fakeId('00Q', 1)],
        at: '2026-10-14T08:01:10.000Z',
        job: JOB2,
      }),
      JSON.stringify({ end: { at: '2026-10-14T08:01:11.000Z', status: 'failure' } }),
    ].join('\n');

    const run = readRunFile(text);

    expect(run?.jobs).toEqual([
      { objectApiName: 'Contact', rows: 300, at: '2026-10-14T08:00:02.000Z', job: JOB },
    ]);
    expect(run?.inFlight).toBeUndefined();
    expect(run).not.toHaveProperty('answersNameJobs');
  });

  it('reads a file written before answers named their job: the next line of its object answers it', () => {
    const text = [
      JSON.stringify({ run: start('run-before') }),
      JSON.stringify({
        sending: { object: 'Contact', rows: 300, at: '2026-10-14T08:00:02.000Z', job: JOB },
      }),
      JSON.stringify({
        object: 'Contact',
        created: [fakeId('003', 1)],
        at: '2026-10-14T08:00:31.000Z',
      }),
      JSON.stringify({
        sending: { object: 'Lead', rows: 400, at: '2026-10-14T08:00:41.000Z', job: JOB2 },
      }),
      JSON.stringify({ end: { at: '2026-10-14T08:01:11.000Z', status: 'failure' } }),
    ].join('\n');

    expect(readRunFile(text)?.jobs).toEqual([
      { objectApiName: 'Lead', rows: 400, at: '2026-10-14T08:00:41.000Z', job: JOB2 },
    ]);
  });

  it('names the job an answer answers, and an answer read back from the org answers it', async () => {
    const { files, deps } = memoryDisk();
    const store = new SyncRunCreations(deps);
    const recorder = store.recorder(start('run-1'));
    recorder.sending?.('Contact', 300);
    recorder.sending?.('Contact', 300, { job: JOB });
    recorder.answered?.('Contact', [fakeId('003', 1)]);
    recorder.sending?.('Lead', 400);
    recorder.sending?.('Lead', 400, { job: JOB2 });
    await recorder.end({ status: 'failure' });

    const lines = (files.get(path.join(DIR, 'run-1.ndjson')) ?? '').trim().split('\n');
    expect(JSON.parse(lines[0])).toMatchObject({ run: { answersNameJobs: true } });
    expect(lines.map((line) => JSON.parse(line) as Record<string, unknown>)).toContainEqual(
      expect.objectContaining({ object: 'Contact', created: [fakeId('003', 1)], job: JOB }),
    );
    expect((await store.get('run-1'))?.jobs?.map((call) => call.job)).toEqual([JOB2]);

    expect(
      await store.answerInFlight(
        'run-1',
        'Lead',
        [fakeId('00Q', 1)],
        '2026-10-14T08:02:00.000Z',
        JOB2,
      ),
    ).toBe(true);
    const run = await store.get('run-1');
    expect(run?.jobs).toBeUndefined();
    expect(run?.created).toEqual([
      { objectApiName: 'Contact', ids: [fakeId('003', 1)] },
      { objectApiName: 'Lead', ids: [fakeId('00Q', 1)] },
    ]);
  });

  it('dates its last write by the latest line, an update or the answer of a call that created nothing included', () => {
    const text = [
      JSON.stringify({ run: start('run-last') }),
      JSON.stringify({ sending: { object: 'Contact', rows: 2, at: '2026-10-14T08:00:06.000Z' } }),
      JSON.stringify({
        object: 'Contact',
        created: [fakeId('003', 1)],
        at: '2026-10-14T08:00:09.000Z',
      }),
      JSON.stringify({ writing: { object: 'Account', rows: 30, at: '2026-10-14T08:03:00.000Z' } }),
      JSON.stringify({ writing: { object: 'Account', rows: 30, at: '2026-10-14T08:04:30.000Z' } }),
      // An upsert whose rows all matched: it created nothing, and updated them.
      JSON.stringify({ sending: { object: 'Lead', rows: 5, at: '2026-10-14T08:05:00.000Z' } }),
      JSON.stringify({ object: 'Lead', created: [], at: '2026-10-14T08:05:20.000Z' }),
      JSON.stringify({ end: { at: '2026-10-14T08:09:00.000Z', status: 'success' } }),
    ].join('\n');

    const run = readRunFile(text);

    expect(run?.lastWriteAt).toBe('2026-10-14T08:05:20.000Z');
    // What it created, as its removal reads changes since against.
    expect(run?.lastWrittenAt).toBe('2026-10-14T08:00:09.000Z');
    expect(run?.firstWrittenAt).toBe('2026-10-14T08:00:06.000Z');
  });

  it('leaves out a line a closed window cut short, and reads the rest', () => {
    const text =
      `${JSON.stringify({ run: start('run-1') })}\n` +
      `${JSON.stringify({ object: 'Account', created: [fakeId('001', 1)] })}\n` +
      '{"object":"Account","created":["001000';

    expect(readRunFile(text)?.created).toEqual([
      { objectApiName: 'Account', ids: [fakeId('001', 1)] },
    ]);
  });

  it('says once why what was noted could not be written, and never throws', async () => {
    const { deps } = memoryDisk({
      appendFile: vi.fn(async () => {
        throw new Error('ENOSPC: no space left on device');
      }),
    });
    const recorder = new SyncRunCreations(deps).recorder(start('run-1'));

    expect(() => recorder.note('Account', [fakeId('001', 1)])).not.toThrow();
    expect(await recorder.flush()).toBe('ENOSPC: no space left on device');
    recorder.note('Account', [fakeId('001', 2)]);
    expect(await recorder.flush()).toBe('ENOSPC: no space left on device');
    expect(deps.appendFile).toHaveBeenCalledTimes(1);
  });

  it('keeps what a run creates when room cannot be made for it', async () => {
    const { deps } = memoryDisk({
      listFiles: vi.fn(async () => {
        throw new Error('EACCES: permission denied');
      }),
    });
    const store = new SyncRunCreations(deps);
    const recorder = store.recorder(start('run-1'));

    recorder.note('Account', [fakeId('001', 1)]);

    expect(await recorder.flush()).toBeUndefined();
    expect((await store.get('run-1'))?.created).toEqual([
      { objectApiName: 'Account', ids: [fakeId('001', 1)] },
    ]);
  });

  it('lists every run kept, newest first, and leaves out a file that names none', async () => {
    const { files, deps } = memoryDisk();
    const store = new SyncRunCreations(deps);
    const older = store.recorder(start('run-1', '2026-10-13T08:00:00.000Z'));
    const newer = store.recorder(start('run-2', '2026-10-14T08:00:00.000Z'));
    older.note('Account', [fakeId('001', 1)]);
    newer.note('Account', [fakeId('001', 2)]);
    await Promise.all([older.flush(), newer.flush()]);
    files.set(path.join(DIR, 'stray.ndjson'), 'not a run\n');

    expect((await store.list()).map((run) => run.runId)).toEqual(['run-2', 'run-1']);
  });

  it('keeps what the removals of a run did beside it, read back with it', async () => {
    const { deps } = memoryDisk();
    const store = new SyncRunCreations(deps);
    const recorder = store.recorder(start('run-1'));
    recorder.note('Account', [fakeId('001', 1), fakeId('001', 2)]);
    await recorder.end({ status: 'success' });

    await store.updateRemoval('run-1', (state) => ({
      ...state,
      undo: {
        removedAt: '2026-10-14T09:00:00.000Z',
        deleted: 1,
        alreadyGone: 0,
        kept: 1,
        refused: 0,
      },
      removalLeft: [fakeId('001', 2)],
    }));

    expect((await store.get('run-1'))?.removal).toEqual({
      undo: {
        removedAt: '2026-10-14T09:00:00.000Z',
        deleted: 1,
        alreadyGone: 0,
        kept: 1,
        refused: 0,
      },
      removalLeft: [fakeId('001', 2)],
    });
    // Written through a file renamed over it.
    expect(deps.rename).toHaveBeenCalledWith(
      expect.stringMatching(/run-1\.removal\.json\.\d+\.tmp$/),
      path.join(DIR, 'run-1.removal.json'),
    );
  });

  describe('within their bounds', () => {
    /** A run of `count` accounts, its removal settled or not. */
    async function seedRun(
      store: SyncRunCreations,
      runId: string,
      startedAt: string,
      count: number,
      settled: boolean,
    ): Promise<void> {
      const recorder = store.recorder(start(runId, startedAt));
      recorder.note(
        'Account',
        Array.from({ length: count }, (_, n) => fakeId('001', n + 1)),
      );
      await recorder.end({ status: 'success' });
      if (settled) {
        await store.updateRemoval(runId, () => ({
          undo: {
            removedAt: '2026-10-14T09:00:00.000Z',
            deleted: count,
            alreadyGone: 0,
            kept: 0,
            refused: 0,
          },
        }));
      }
    }

    it('drops the runs removed with nothing left first, oldest first, past the soft bound', async () => {
      const { deps } = memoryDisk();
      const seeding = new SyncRunCreations(deps);
      await seedRun(seeding, 'old-settled', '2026-10-01T00:00:00.000Z', 40, true);
      await seedRun(seeding, 'old-kept', '2026-10-02T00:00:00.000Z', 40, false);
      const store = new SyncRunCreations({ ...deps, maxBytes: 1_500, hardMaxBytes: 100_000 });

      const recorder = store.recorder(start('new', '2026-10-14T00:00:00.000Z'));
      recorder.note('Account', [fakeId('001', 1)]);
      await recorder.flush();

      expect((await store.list()).map((run) => run.runId)).toEqual(['new', 'old-kept']);
    });

    it('drops the oldest runs whatever they hold past the hard bound, never the one beginning', async () => {
      const { deps } = memoryDisk();
      const seeding = new SyncRunCreations(deps);
      await seedRun(seeding, 'oldest', '2026-10-01T00:00:00.000Z', 40, false);
      await seedRun(seeding, 'older', '2026-10-02T00:00:00.000Z', 40, false);
      const store = new SyncRunCreations({ ...deps, maxBytes: 1_000, hardMaxBytes: 1_500 });

      const recorder = store.recorder(start('new', '2026-10-14T00:00:00.000Z'));
      recorder.note('Account', [fakeId('001', 1)]);
      await recorder.flush();

      expect((await store.list()).map((run) => run.runId)).toEqual(['new', 'older']);
    });
  });
});

describe('syncRemovalPlan', () => {
  const created = [
    { objectApiName: 'Account', ids: [fakeId('001', 1), fakeId('001', 2)] },
    { objectApiName: 'Attachment', ids: [fakeId('00P', 1)] },
    { objectApiName: 'Contact', ids: [fakeId('003', 1)] },
    { objectApiName: 'ContentDocument', ids: [fakeId('069', 1)] },
  ];

  it('takes the files first, then each object in the reverse of the order written, the last record first', () => {
    expect(syncRemovalPlan({ created })).toEqual([
      { objectApiName: 'ContentDocument', ids: [fakeId('069', 1)] },
      { objectApiName: 'Attachment', ids: [fakeId('00P', 1)] },
      { objectApiName: 'Contact', ids: [fakeId('003', 1)] },
      { objectApiName: 'Account', ids: [fakeId('001', 2), fakeId('001', 1)] },
    ]);
  });

  it('takes only what earlier removals left', () => {
    expect(
      syncRemovalPlan({
        created,
        removal: {
          undo: {
            removedAt: '2026-10-14T09:00:00.000Z',
            deleted: 4,
            alreadyGone: 0,
            kept: 1,
            refused: 0,
          },
          removalLeft: [fakeId('001', 1)],
        },
      }),
    ).toEqual([{ objectApiName: 'Account', ids: [fakeId('001', 1)] }]);
  });

  it('takes nothing once a removal left none', () => {
    expect(
      syncRemovalPlan({
        created,
        removal: {
          undo: {
            removedAt: '2026-10-14T09:00:00.000Z',
            deleted: 5,
            alreadyGone: 0,
            kept: 0,
            refused: 0,
          },
        },
      }),
    ).toEqual([]);
  });
});
