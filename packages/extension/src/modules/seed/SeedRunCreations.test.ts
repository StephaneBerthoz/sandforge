import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SEED_RUNS_DIR,
  SeedRunCreations,
  nodeSeedRunCreations,
  seedRunKept,
  type SeedRunEnded,
} from './SeedRunCreations';
import { nodeSyncRunCreations, syncRemovalPlan } from '../sync/SyncRunCreations';

const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

function run(runId: string, extra: Partial<SeedRunEnded> = {}): SeedRunEnded {
  return {
    runId,
    targetOrgId: 'org-target',
    startedAt: '2026-10-17T10:00:00.000Z',
    finishedAt: '2026-10-17T10:01:00.000Z',
    status: 'success',
    objectResults: [
      { objectApiName: 'Account', createdIds: [fakeId('001', 1), fakeId('001', 2)] },
      { objectApiName: 'Contact', createdIds: [fakeId('003', 1)] },
      { objectApiName: 'Opportunity', createdIds: [] },
    ],
    ...extra,
  };
}

describe('seedRunKept', () => {
  it('reads a run as the removal reads one: what it created per object, the objects it wrote none of left out', () => {
    const kept = seedRunKept(run('op-1'));

    expect(kept).toMatchObject({
      runId: 'op-1',
      targetOrgId: 'org-target',
      startedAt: '2026-10-17T10:00:00.000Z',
      end: { at: '2026-10-17T10:01:00.000Z', status: 'success' },
      lastWrittenAt: '2026-10-17T10:01:00.000Z',
      created: [
        { objectApiName: 'Account', ids: [fakeId('001', 1), fakeId('001', 2)] },
        { objectApiName: 'Contact', ids: [fakeId('003', 1)] },
      ],
    });
    // The children first, the last record written first.
    expect(syncRemovalPlan(kept).map((o) => o.objectApiName)).toEqual(['Contact', 'Account']);
  });
});

describe('SeedRunCreations', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sandforge-seed-runs-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps what a run created on disk, where a store made after a reload reads it whole', async () => {
    await nodeSeedRunCreations(dir).record(run('op-1'));

    // A new store over the same directory: the window was reloaded.
    const kept = await nodeSeedRunCreations(dir).get('op-1');

    expect(kept).toMatchObject({
      runId: 'op-1',
      targetOrgId: 'org-target',
      startedAt: '2026-10-17T10:00:00.000Z',
      end: { status: 'success' },
      created: [
        { objectApiName: 'Account', ids: [fakeId('001', 1), fakeId('001', 2)] },
        { objectApiName: 'Contact', ids: [fakeId('003', 1)] },
      ],
    });
    expect(syncRemovalPlan(kept!).map((o) => o.objectApiName)).toEqual(['Contact', 'Account']);
    // Beside a Sync run's, never among them.
    expect(readdirSync(join(dir, SEED_RUNS_DIR))).toEqual(['op-1.ndjson']);
    expect(await nodeSyncRunCreations(dir).list()).toEqual([]);
  });

  it('writes each insert down as it is noted, so a run that never ended is read back with what it wrote', async () => {
    const recorder = nodeSeedRunCreations(dir).recorder({
      runId: 'op-cut',
      targetOrgId: 'org-target',
      startedAt: '2026-10-17T10:00:00.000Z',
    });
    recorder.note('Account', [fakeId('001', 1), fakeId('001', 2)]);
    recorder.note('Contact', [fakeId('003', 1)]);

    // The window closed: no end. A store made after the reload reads the file.
    await vi.waitFor(async () =>
      expect((await nodeSeedRunCreations(dir).get('op-cut'))?.created).toHaveLength(2),
    );
    const kept = await nodeSeedRunCreations(dir).get('op-cut');
    expect(kept?.end).toBeUndefined();
    expect(kept?.lastWrittenAt).toBeDefined();
    expect(kept?.created).toEqual([
      { objectApiName: 'Account', ids: [fakeId('001', 1), fakeId('001', 2)] },
      { objectApiName: 'Contact', ids: [fakeId('003', 1)] },
    ]);
    expect(syncRemovalPlan(kept!).map((o) => o.objectApiName)).toEqual(['Contact', 'Account']);
  });

  it('ends a run it wrote as it went with what its result holds that no insert noted, once', async () => {
    const runs = nodeSeedRunCreations(dir);
    const recorder = runs.recorder({ runId: 'op-1', targetOrgId: 'org-target' });
    recorder.note('Account', [fakeId('001', 1)]);

    await recorder.end(run('op-1'));

    const kept = await runs.get('op-1');
    expect(kept?.end).toMatchObject({ status: 'success', at: '2026-10-17T10:01:00.000Z' });
    expect(kept?.created).toEqual([
      { objectApiName: 'Account', ids: [fakeId('001', 1), fakeId('001', 2)] },
      { objectApiName: 'Contact', ids: [fakeId('003', 1)] },
    ]);
  });

  it('keeps every id of an object past what one line of the file holds', async () => {
    const createdIds = Array.from({ length: 60_000 }, (_, i) => fakeId('003', i + 1));
    await nodeSeedRunCreations(dir).record(
      run('op-big', { objectResults: [{ objectApiName: 'Contact', createdIds }] }),
    );

    const kept = await nodeSeedRunCreations(dir).get('op-big');
    expect(kept?.created).toEqual([{ objectApiName: 'Contact', ids: createdIds }]);
  });

  it('keeps nothing of a run that created nothing', async () => {
    const runs = nodeSeedRunCreations(dir);
    await runs.record(
      run('op-empty', { objectResults: [{ objectApiName: 'Account', createdIds: [] }] }),
    );

    expect(await runs.get('op-empty')).toBeUndefined();
    expect(await runs.list()).toEqual([]);
  });

  it('never drops a run whose records are still in its org on a count, and keeps the latest removed ones', async () => {
    const runs = new SeedRunCreations(nodeSyncRunCreations(dir, SEED_RUNS_DIR), 2);
    const at = (minute: number) => `2026-10-17T10:0${minute}:00.000Z`;
    const removed = (runId: string) =>
      runs.updateRemoval(runId, () => ({
        undo: { removedAt: at(9), deleted: 3, alreadyGone: 0, kept: 0, refused: 0 },
      }));
    // A seed never removed, then more runs than the bound: it stays listed.
    await runs.record(run('op-1', { startedAt: at(1) }));
    await runs.record(run('op-2', { startedAt: at(2) }));
    await runs.record(run('op-3', { startedAt: at(3) }));
    expect((await runs.list()).map((r) => r.runId)).toEqual(['op-3', 'op-2', 'op-1']);

    // Three removed whole: the oldest of them goes, never the one left in its org.
    await removed('op-2');
    await removed('op-3');
    await runs.record(run('op-4', { startedAt: at(4) }));
    await removed('op-4');
    await runs.record(run('op-5', { startedAt: at(5) }));

    expect((await runs.list()).map((r) => r.runId)).toEqual(['op-5', 'op-4', 'op-3', 'op-1']);
  });

  it('keeps each call before it goes, a job again with its id once opened, so a run cut short during a job names it', async () => {
    const recorder = nodeSeedRunCreations(dir).recorder({
      runId: 'op-job',
      targetOrgId: 'org-target',
      startedAt: '2026-10-17T10:00:00.000Z',
    });
    recorder.sending('Account', 2);
    recorder.answered('Account', [fakeId('001', 1), fakeId('001', 2)]);
    recorder.sending('Contact', 450);
    recorder.sending('Contact', 450, { job: fakeId('750', 7) });

    // The window closed while the job ran: no answer, no end.
    await vi.waitFor(async () =>
      expect((await nodeSeedRunCreations(dir).get('op-job'))?.inFlight?.job).toBe(fakeId('750', 7)),
    );
    const kept = await nodeSeedRunCreations(dir).get('op-job');
    expect(kept?.inFlight).toMatchObject({ objectApiName: 'Contact', rows: 450 });
    expect(kept?.created).toEqual([
      { objectApiName: 'Account', ids: [fakeId('001', 1), fakeId('001', 2)] },
    ]);
  });

  it('answers a job a closed window left under way with what the org says it created, listed and removed with the run', async () => {
    const runs = nodeSeedRunCreations(dir);
    const recorder = runs.recorder({ runId: 'op-job', targetOrgId: 'org-target' });
    recorder.answered('Account', [fakeId('001', 1)]);
    recorder.sending('Contact', 2, { job: fakeId('750', 7) });
    await vi.waitFor(async () => expect((await runs.get('op-job'))?.inFlight).toBeDefined());

    // The job ended after the window closed: its records are dated then.
    const jobEnded = new Date(Date.now() + 60_000).toISOString();
    const answered = await nodeSeedRunCreations(dir).answerInFlight(
      'op-job',
      'Contact',
      [fakeId('003', 1), fakeId('003', 2)],
      jobEnded,
      fakeId('750', 7),
    );

    expect(answered).toBe(true);
    const kept = await nodeSeedRunCreations(dir).get('op-job');
    expect(kept?.inFlight).toBeUndefined();
    expect(kept?.jobs).toBeUndefined();
    expect(kept?.lastWrittenAt).toBe(jobEnded);
    expect(syncRemovalPlan(kept!)).toEqual([
      { objectApiName: 'Contact', ids: [fakeId('003', 2), fakeId('003', 1)] },
      { objectApiName: 'Account', ids: [fakeId('001', 1)] },
    ]);
    expect(await runs.answerInFlight('never-ran', 'Contact', [], '2026-10-17T10:05:00.000Z')).toBe(
      false,
    );
  });

  it('closes a call whose every row was refused, so the run is not read as one cut short during it', async () => {
    const runs = nodeSeedRunCreations(dir);
    const recorder = runs.recorder({ runId: 'op-refused', targetOrgId: 'org-target' });
    recorder.answered('Account', [fakeId('001', 1)]);
    recorder.sending('Contact', 3);
    recorder.answered('Contact', []);

    await vi.waitFor(async () => {
      const kept = await runs.get('op-refused');
      expect(kept?.created).toHaveLength(1);
      expect(kept?.inFlight).toBeUndefined();
    });
  });

  it('dates the records a run wrote to again, as a clone fills the lookups they went in without, as its own write', async () => {
    const runs = nodeSeedRunCreations(dir);
    const recorder = runs.recorder({ runId: 'op-pass', targetOrgId: 'org-target' });
    recorder.answered('Account', [fakeId('001', 1)]);
    await vi.waitFor(async () => expect((await runs.get('op-pass'))?.lastWrittenAt).toBeDefined());
    const inserted = (await runs.get('op-pass'))?.lastWrittenAt ?? '';
    await new Promise((resolve) => setTimeout(resolve, 5));

    // An id the run did not create is none of its writes.
    recorder.wroteAgain('Account', [fakeId('001', 1), fakeId('001', 9)]);

    await vi.waitFor(async () =>
      expect(Date.parse((await runs.get('op-pass'))?.lastWrittenAt ?? '')).toBeGreaterThan(
        Date.parse(inserted),
      ),
    );
    expect((await runs.get('op-pass'))?.created).toEqual([
      { objectApiName: 'Account', ids: [fakeId('001', 1)] },
    ]);
  });

  it('keeps the file of a run whose job the org opened and never answered, though nothing was noted', async () => {
    // The seed's write failed while its job ran on in the org: the run's file
    // went with nothing noted, and the job's records stayed with no line of them.
    const runs = nodeSeedRunCreations(dir);
    const recorder = runs.recorder({ runId: 'op-failed', targetOrgId: 'org-target' });
    recorder.sending('Contact', 450);
    recorder.sending('Contact', 450, { job: fakeId('750', 8) });

    await recorder.end({ status: 'failure', objectResults: [] });

    const kept = await runs.get('op-failed');
    expect(kept?.end?.status).toBe('failure');
    expect(kept?.jobs).toEqual([
      { objectApiName: 'Contact', rows: 450, at: expect.any(String), job: fakeId('750', 8) },
    ]);
  });

  it('leaves no file of a run whose calls went and created nothing', async () => {
    const runs = nodeSeedRunCreations(dir);
    const recorder = runs.recorder({ runId: 'op-none', targetOrgId: 'org-target' });
    recorder.sending('Contact', 3);
    recorder.answered('Contact', []);

    await recorder.end({ status: 'failure', objectResults: [] });

    expect(await runs.get('op-none')).toBeUndefined();
    expect(readdirSync(join(dir, SEED_RUNS_DIR))).toEqual([]);
  });

  it('names the way a CSV import or a clone wrote, and the org a clone read from', async () => {
    const runs = nodeSeedRunCreations(dir);
    const clone = runs.recorder({
      runId: 'op-clone',
      targetOrgId: 'org-target',
      sourceOrgId: 'org-source',
      origin: 'clone',
    });
    clone.answered('Contact', [fakeId('003', 1)]);
    await clone.end({ status: 'success', objectResults: [] });
    const csv = runs.recorder({ runId: 'op-csv', targetOrgId: 'org-target', origin: 'csv' });
    csv.answered('Account', [fakeId('001', 1)]);
    await csv.end({ status: 'success', objectResults: [] });

    expect(await nodeSeedRunCreations(dir).get('op-clone')).toMatchObject({
      origin: 'clone',
      sourceOrgId: 'org-source',
      targetOrgId: 'org-target',
    });
    expect(await nodeSeedRunCreations(dir).get('op-csv')).toMatchObject({
      origin: 'csv',
      sourceOrgId: 'org-target',
    });
  });

  it("keeps the org's own id of a command line's run, whose target is an alias, in the file it names", async () => {
    // Read by its removal, which refuses any other org whatever the alias names by then.
    const runs = nodeSeedRunCreations(dir);
    const recorder = runs.recorder({
      runId: 'sandforge-seed-1',
      targetOrgId: 'TGT',
      targetOrganizationId: '00D000000000001AAA',
    });
    recorder.note('Account', [fakeId('001', 1)]);
    await recorder.end({ status: 'success', objectResults: [] });

    expect(runs.pathOf('sandforge-seed-1')).toBe(
      join(dir, SEED_RUNS_DIR, 'sandforge-seed-1.ndjson'),
    );
    expect(await nodeSeedRunCreations(dir).get('sandforge-seed-1')).toMatchObject({
      targetOrgId: 'TGT',
      targetOrganizationId: '00D000000000001AAA',
    });
  });

  it('keeps what a removal did on the run, for the next removal to read after a reload', async () => {
    const runs = nodeSeedRunCreations(dir);
    await runs.record(run('op-1'));

    await runs.updateRemoval('op-1', (state) => ({
      ...state,
      removalLeft: [fakeId('001', 2)],
    }));

    const kept = await nodeSeedRunCreations(dir).get('op-1');
    expect(kept?.removal).toEqual({ removalLeft: [fakeId('001', 2)] });
    expect(syncRemovalPlan(kept!)).toEqual([{ objectApiName: 'Account', ids: [fakeId('001', 2)] }]);
    await runs.updateRemoval('never-ran', (state) => state);
    expect(await runs.get('never-ran')).toBeUndefined();
  });
});
