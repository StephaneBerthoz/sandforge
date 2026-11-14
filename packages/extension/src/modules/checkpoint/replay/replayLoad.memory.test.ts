import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v8 from 'node:v8';
import { runInNewContext } from 'node:vm';

import { REPLAY_MAX_RECORDS, type CheckpointReplayChoices } from '@sandforge/shared';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { to18 } from '../../../core/common/salesforceId.js';
import { ProductionGuard } from '../../../core/precheck/ProductionGuard.js';
import { nodeBackupFiles } from '../../dataops/BackupRecordStore.js';
import { FrozenDatasetLoader } from '../../frozendataset/FrozenDatasetLoader.js';
import { SasPathGuard } from '../../frozendataset/SasPathGuard.js';
import { TargetRecordTypeIdResolver } from '../../frozendataset/TargetRecordTypeIdResolver.js';
import type {
  FrozenDmlWriter,
  TargetFieldDescribe,
  TargetObjectDescribe,
  TargetOrgAccess,
} from '../../frozendataset/loadTypes.js';
import type { OperationOutcome } from '../../sync/DataSync.js';
import { openCheckpointStore } from '../OrgCheckpointStore.js';
import { compressedSnapshotFiles } from '../compressedSnapshotFiles.js';
import { snapshotFileOf, writeSnapshotIndex } from '../snapshotIndex.js';
import { fabricateCheckpoint, TARGET_ORG_ID } from '../../../test/replayOrgs.js';
import { readReplayAnnex } from './replayAnnex.js';
import { convertCheckpoint } from './checkpointToDataset.js';
import { ReplayStore } from './replayStore.js';

vi.mock('../../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * A replay holds what it sets up in memory, as a Frozen load does: the
 * checkpoint's records converted, then aligned and sent by the loader, which
 * was made for datasets of a few thousand records. This measures, on the heap
 * left once the garbage is collected, sampled as it goes, what a replay of a
 * checkpoint of `records` holds — parents and children of forty fields each,
 * as a checkpoint keeps an org's records — and how long its conversion, its
 * dry run and its load take, the other org answering at once.
 *
 * Measured so, a replay held some 4 KB a record live, in a straight line:
 * 195 MB at 50,000 records, 389 MB at 100,000 and 779 MB at 200,000 (966 MB
 * with its garbage), its conversion, dry run and load taking 10, 5 and 7
 * seconds at 200,000. The bound a replay refuses past (`REPLAY_MAX_RECORDS`)
 * is the largest whose live peak is under half a gigabyte: records twice as
 * wide then stay under a gigabyte of a process an editor shares with other
 * extensions. Before the conversion grew its lists in place, it took 14
 * seconds at 50,000 records, and four times as long each time they doubled.
 *
 * `SANDFORGE_REPLAY_SIZES=50000,100000,200000` measures other sizes.
 */

/** Under this, the replay's live peak at the bound. */
const PEAK_BOUND = 512 * 1024 * 1024;

/** The sizes measured: the bound alone, unless `SANDFORGE_REPLAY_SIZES` names others. */
const SIZES = (process.env['SANDFORGE_REPLAY_SIZES'] ?? String(REPLAY_MAX_RECORDS))
  .split(',')
  .map((size) => Number(size.trim()))
  .filter((size) => Number.isInteger(size) && size > 0);

const PARENT = 'SFX_Replay_Parent__c';
const CHILD = 'SFX_Replay_Child__c';
const SOURCE_OWNER = to18('005000000000001');
const RUNNING_USER = to18('005000000000990');

/** A source id of `prefix`, numbered. */
const sourceId = (prefix: string, n: number): string =>
  to18(`${prefix}${String(n).padStart(12, '0')}`);

/** An id the other org gives a record it creates: told apart by its fourth character. */
const writtenId = (prefix: string, n: number): string =>
  to18(`${prefix}W${String(n).padStart(11, '0')}`);

/** The forty fields of a record of either object, by name and type. */
function fieldsOf(objectApiName: string): Array<{ name: string; type: string }> {
  const texts = objectApiName === CHILD ? 14 : 15;
  const two = (n: number): string => String(n).padStart(2, '0');
  return [
    { name: 'Name', type: 'string' },
    ...Array.from({ length: texts }, (_, i) => ({
      name: `SFX_Text_${two(i + 1)}__c`,
      type: 'string',
    })),
    ...Array.from({ length: 8 }, (_, i) => ({
      name: `SFX_Number_${two(i + 1)}__c`,
      type: 'double',
    })),
    ...Array.from({ length: 6 }, (_, i) => ({ name: `SFX_Date_${two(i + 1)}__c`, type: 'date' })),
    ...Array.from({ length: 4 }, (_, i) => ({
      name: `SFX_Pick_${two(i + 1)}__c`,
      type: 'picklist',
    })),
    ...Array.from({ length: 3 }, (_, i) => ({
      name: `SFX_Flag_${two(i + 1)}__c`,
      type: 'boolean',
    })),
    { name: 'SFX_Email__c', type: 'email' },
    { name: 'SFX_Phone__c', type: 'phone' },
    { name: 'OwnerId', type: 'reference' },
    ...(objectApiName === CHILD ? [{ name: 'SFX_Parent__c', type: 'reference' }] : []),
  ];
}

/** A record of the checkpoint, its forty values made up from its rank. */
function rowOf(
  objectApiName: string,
  n: number,
  parents: number,
): Record<string, unknown> & { Id: string } {
  const row: Record<string, unknown> & { Id: string } = {
    Id: sourceId(objectApiName === PARENT ? 'a01' : 'a02', n),
  };
  for (const { name, type } of fieldsOf(objectApiName)) {
    if (name === 'OwnerId') row[name] = SOURCE_OWNER;
    else if (name === 'SFX_Parent__c') row[name] = sourceId('a01', (n % parents) + 1);
    else if (type === 'double') row[name] = (n * 7919) % 100_003;
    else if (type === 'date') row[name] = `2026-${String((n % 12) + 1).padStart(2, '0')}-15`;
    else if (type === 'picklist') row[name] = ['Alpha', 'Beta', 'Gamma'][n % 3];
    else if (type === 'boolean') row[name] = n % 2 === 0;
    else if (type === 'email') row[name] = `person.${n}@example.com`;
    else if (type === 'phone') row[name] = `+1 555 01${String(n % 100).padStart(2, '0')}`;
    else row[name] = `SFENV value ${n} of ${name}`;
  }
  return row;
}

/** The other org's describe of either object: what a scratch org answers of such custom objects. */
function describeOf(objectApiName: string): TargetObjectDescribe {
  const field = (name: string, type: string): TargetFieldDescribe => ({
    name,
    type,
    createable: true,
    nillable: name !== 'Name',
    defaultedOnCreate: name === 'OwnerId',
    updateable: true,
    ...(name === 'OwnerId' ? { referenceTo: ['User'] } : {}),
    ...(name === 'SFX_Parent__c' ? { referenceTo: [PARENT] } : {}),
    ...(type === 'picklist'
      ? {
          picklistValues: ['Alpha', 'Beta', 'Gamma'].map((value) => ({ value, active: true })),
        }
      : {}),
  });
  return {
    name: objectApiName,
    createable: true,
    fields: [
      { name: 'Id', type: 'id', createable: false, nillable: false, defaultedOnCreate: true },
      ...fieldsOf(objectApiName).map(({ name, type }) => field(name, type)),
    ],
  };
}

/** The ids a statement names in its `IN (…)` list. */
function idsIn(soql: string): string[] {
  const list = /Id IN \(([^)]*)\)/.exec(soql)?.[1] ?? '';
  return list === '' ? [] : list.split(', ').map((quoted) => quoted.slice(1, -1));
}

/**
 * The other org: it answers at once, holds no record of the checkpoint under
 * its Id and no user of it, and keeps nothing it is sent — what it holds is
 * not the replay's to measure — but the count of what it created.
 */
function otherOrg(): { access: TargetOrgAccess; writer: FrozenDmlWriter; created: () => number } {
  let created = 0;
  const access: TargetOrgAccess = {
    query: async (_orgId, soql) => {
      if (/FROM Organization\b/.test(soql)) return [{ Id: TARGET_ORG_ID }];
      if (/FROM User\b/.test(soql)) return [];
      const at = new Date('2026-11-14T10:00:00.000Z').toISOString();
      // What the load reads back of what it wrote: the ids the other org gave.
      return idsIn(soql)
        .filter((id) => id[3] === 'W')
        .map((Id) => ({
          Id,
          CreatedDate: at,
          LastModifiedDate: at,
          SystemModstamp: at,
          CreatedById: RUNNING_USER,
          LastModifiedById: RUNNING_USER,
        }));
    },
    count: async () => 0,
    describe: async (_orgId, objectApiName) => describeOf(objectApiName),
    picklistValues: async () => [],
    userId: async () => RUNNING_USER,
  };
  const answer = (
    records: Array<Record<string, unknown>>,
    onAnswered?: (offset: number, outcomes: readonly OperationOutcome[]) => void,
    prefix = 'a0X',
  ): OperationOutcome[] => {
    const all: OperationOutcome[] = [];
    // As a Bulk API job of ten thousand records answers.
    for (let offset = 0; offset < records.length; offset += 10_000) {
      const outcomes = records
        .slice(offset, offset + 10_000)
        .map(() => ({ success: true, id: writtenId(prefix, ++created), errors: [] }));
      onAnswered?.(offset, outcomes);
      all.push(...outcomes);
    }
    return all;
  };
  const writer: FrozenDmlWriter = {
    insert: async (_orgId, objectApiName, records, onAnswered) =>
      answer(records, onAnswered, objectApiName === PARENT ? 'a01' : 'a02'),
    update: async (_orgId, _objectApiName, records) =>
      records.map((record) => ({ success: true, id: String(record.Id), errors: [] })),
    delete: async (_orgId, _objectApiName, ids) =>
      ids.map((id) => ({ success: true, id, errors: [] })),
  };
  return { access, writer, created: () => created };
}

/** The choices a replay is asked by default. */
const CHOICES: CheckpointReplayChoices = {
  owners: 'same',
  customSettings: false,
  mask: false,
  contactPoints: 'neutralized',
  objects: [],
  excluded: [],
  link: [],
};

const dir = mkdtempSync(join(tmpdir(), 'sandforge-replay-memory-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/**
 * A checkpoint of `records`, a tenth of them parents, written a page at a
 * time as a take writes it, compressed and indexed.
 */
async function checkpointOf(
  records: number,
): Promise<Awaited<ReturnType<typeof fabricateCheckpoint>>> {
  const opened = openCheckpointStore({
    root: join(dir, `store-${records}`),
    locksDir: join(dir, `locks-${records}`),
  });
  if (!('store' in opened)) throw new Error(`refused: ${opened.refusal.reason}`);
  const parents = Math.max(1, Math.floor(records / 10));
  const counts: Record<string, number> = { [PARENT]: parents, [CHILD]: records - parents };
  const made = await fabricateCheckpoint(opened.store, {
    org: { tier: 'scratch', dataStorageMaxMB: 200 },
    objects: [PARENT, CHILD].map((objectApiName) => ({
      objectApiName,
      rows: [],
      fields: ['Id', ...fieldsOf(objectApiName).map((field) => field.name)].sort(),
    })),
    annex: { recordTypes: [], users: [], queues: [] },
  });
  const files = compressedSnapshotFiles(nodeBackupFiles(made.folder.dir));
  for (const objectApiName of [PARENT, CHILD]) {
    const file = snapshotFileOf(made.folder, made.checkpoint.snapshotId, objectApiName);
    for (let from = 1; from <= counts[objectApiName]; from += 5_000) {
      const to = Math.min(counts[objectApiName], from + 4_999);
      const lines: string[] = [];
      for (let n = from; n <= to; n++) {
        lines.push(
          `${JSON.stringify({ ...rowOf(objectApiName, n, parents), SystemModstamp: '2026-11-01T08:00:00.000Z' })}\n`,
        );
      }
      await files.appendFile(file, lines.join(''));
    }
    await writeSnapshotIndex(made.folder, made.checkpoint.snapshotId, objectApiName);
  }
  const checkpoint = {
    ...made.checkpoint,
    objects: made.checkpoint.objects.map((object) => ({
      ...object,
      records: counts[object.objectApiName] ?? 0,
    })),
  };
  await opened.store.write(checkpoint);
  return { checkpoint, folder: made.folder };
}

/**
 * Run as the extension ships, never under Stryker, whose workers it names
 * (STRYKER_MUTATOR_WORKER): instrumented, a replay of hundreds of thousands
 * of records through counted code takes past the time Stryker gives its
 * initial test run.
 */
const describeShipped =
  process.env['STRYKER_MUTATOR_WORKER'] === undefined ? describe : describe.skip;

describeShipped('a replay of a checkpoint at the bound it refuses past', () => {
  for (const records of SIZES) {
    it(`converts, plans and loads ${records.toLocaleString('en-US')} records of forty fields under half a gigabyte`, async () => {
      v8.setFlagsFromString('--expose-gc');
      const collect = runInNewContext('gc') as () => void;
      const heapNow = (): number => {
        const { heapUsed, arrayBuffers } = process.memoryUsage();
        return heapUsed + arrayBuffers;
      };
      const { checkpoint, folder } = await checkpointOf(records);
      const org = otherOrg();
      const replays = new ReplayStore({ root: join(dir, `replays-${records}`) });
      const replayFolder = replays.folderOf(checkpoint.org.organizationId, checkpoint.checkpointId);
      collect();
      const before = heapNow();
      // What it holds live, the garbage collected, once a second; and all it
      // holds, garbage with it, as often as the loop lets it.
      let peak = before;
      let held = before;
      const sampling = setInterval(() => {
        held = Math.max(held, heapNow());
      }, 5);
      const live = setInterval(() => {
        collect();
        peak = Math.max(peak, heapNow());
      }, 1_000);
      const timed: Record<string, number> = {};
      const time = async <T>(step: string, run: () => Promise<T>): Promise<T> => {
        const started = performance.now();
        try {
          return await run();
        } finally {
          timed[step] = Math.round(performance.now() - started);
          held = Math.max(held, heapNow());
          collect();
          peak = Math.max(peak, heapNow());
        }
      };
      try {
        const converted = await time('convert', async () =>
          convertCheckpoint({
            folder,
            checkpoint,
            annex: await readReplayAnnex(folder),
            choices: CHOICES,
            access: org.access,
            orgId: 'target',
            organizationId: TARGET_ORG_ID,
            runningUserId: RUNNING_USER,
            tier: 'scratch',
            targetName: 'TARGET',
            salt: 'memory',
          }),
        );
        if (!('conversion' in converted)) throw new Error(converted.refusal.message);
        const { dataset } = converted.conversion;
        const loader = new FrozenDatasetLoader({
          orgAccess: org.access,
          writer: org.writer,
          guard: new ProductionGuard(),
          mockDetector: { areCalloutsMocked: async () => true },
          recordTypeResolver: new TargetRecordTypeIdResolver(org.access),
          mappingStore: replays.mappingStoreOf(replayFolder, TARGET_ORG_ID, {
            organizationId: TARGET_ORG_ID,
          }),
          sasGuard: new SasPathGuard(),
        });
        await replays.record(
          checkpoint,
          { organizationId: TARGET_ORG_ID, name: 'TARGET' },
          CHOICES,
        );
        const options = {
          orgId: 'target',
          orgTier: 'scratch' as const,
          dataset,
          sasDir: replayFolder.dir,
        };
        const plan = await time('plan', () => loader.planLoad(options));
        const toInsert = plan.perObject.reduce((sum, object) => sum + object.toInsert, 0);
        const report = await time('load', () => loader.load({ ...options, maxRecords: toInsert }));
        clearInterval(sampling);
        clearInterval(live);
        const inserted = report.perObject.reduce((sum, object) => sum + object.inserted, 0);
        process.stderr.write(
          `[replay memory] ${records} records: live peak +${Math.round((peak - before) / 1024 / 1024)} MB, ` +
            `held +${Math.round((held - before) / 1024 / 1024)} MB, ` +
            `convert ${timed.convert} ms, plan ${timed.plan} ms, load ${timed.load} ms\n`,
        );
        expect(toInsert).toBe(records);
        expect(inserted).toBe(records);
        expect(org.created()).toBe(records);
        if (records <= REPLAY_MAX_RECORDS) {
          expect(peak - before).toBeLessThan(PEAK_BOUND);
          // Some 4 seconds at the bound; a conversion that copies a list at
          // each record takes a minute.
          expect(timed.convert).toBeLessThan(30_000);
        }
      } finally {
        clearInterval(sampling);
        clearInterval(live);
      }
    }, 1_800_000);
  }
});
