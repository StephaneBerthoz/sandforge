import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  auditHostFolderOf,
  auditHostKey,
  auditInventorySchema,
  inventoryAgainst,
  inventoryFileOf,
  readInventories,
  saveInventory,
  type AuditInventory,
} from './auditStore.js';

const HOST = 'acme--uat.sandbox.my.salesforce.com';
/** The sandbox before its refresh, and after: another Organization Id under the same host. */
const BEFORE = '00Dxx0000001gPLEAY';
const AFTER = '00Dxx0000002AbCEAU';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function journal(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sandforge-audit-store-'));
  made.push(dir);
  return dir;
}

function inventory(over: Partial<AuditInventory> = {}): AuditInventory {
  return {
    version: 1,
    savedAt: '2026-11-18T20:00:00.000Z',
    organizationId: BEFORE,
    host: HOST,
    jobs: [
      {
        name: 'Nightly ERP sync',
        type: 'Scheduled Apex',
        cronExpression: '0 0 2 * * ?',
        state: 'WAITING',
        nextFireTime: '2026-11-19T02:00:00.000Z',
        owner: 'ops.batch@acme.com.uat',
      },
    ],
    ...over,
  };
}

describe('the inventories of scheduled jobs on this machine', () => {
  it('are filed by the host the org answered on, which a refresh keeps, never by its Id', () => {
    expect(auditHostFolderOf('/j', 'ACME--UAT.sandbox.my.salesforce.com.')).toBe(
      join(resolve('/j'), 'audits', HOST),
    );
    expect(auditHostKey('../../etc')).toBeUndefined();
    expect(() => auditHostFolderOf('/j', 'a/b')).toThrow('Not a host name');
  });

  it('are named by when they were saved and of which org, with no colon a Windows path refuses', () => {
    expect(inventoryFileOf({ savedAt: '2026-11-18T20:00:00.000Z', organizationId: BEFORE })).toBe(
      '20261118T200000000Z-00Dxx0000001gPLEAY.json',
    );
  });

  it('are written for their owner alone, in folders their owner alone lists', async () => {
    const dir = journal();
    const path = await saveInventory(dir, inventory());
    expect(path).toBe(join(dir, 'audits', HOST, '20261118T200000000Z-00Dxx0000001gPLEAY.json'));
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, 'audits', HOST)).mode & 0o777).toBe(0o700);
    }
    expect(readdirSync(join(dir, 'audits', HOST))).toEqual([
      '20261118T200000000Z-00Dxx0000001gPLEAY.json',
    ]);
  });

  it('keep no address of a job’s owner: an inventory with one does not read', () => {
    const withAddress = inventory();
    const job = { ...withAddress.jobs[0], ownerEmail: 'ops.batch@acme.com' };
    expect(auditInventorySchema.safeParse({ ...withAddress, jobs: [job] }).success).toBe(false);
  });

  it('are read newest first, and a file that does not read is set aside with why, never taken', async () => {
    const dir = journal();
    await saveInventory(dir, inventory());
    await saveInventory(dir, inventory({ savedAt: '2026-11-19T20:00:00.000Z' }));
    const folder = join(dir, 'audits', HOST);
    writeFileSync(join(folder, '20261120T200000000Z-00Dxx0000001gPLEAY.json'), '{ not json');
    writeFileSync(join(folder, 'notes.json'), '{}');
    writeFileSync(
      join(folder, '20261121T200000000Z-00Dxx0000001gPLEAY.json'),
      JSON.stringify(inventory({ host: 'other--uat.sandbox.my.salesforce.com' })),
    );
    const read = await readInventories(dir, HOST);
    expect(read.kept.map((one) => one.inventory.savedAt)).toEqual([
      '2026-11-19T20:00:00.000Z',
      '2026-11-18T20:00:00.000Z',
    ]);
    expect(read.setAside.map((one) => one.why)).toEqual([
      'it does not read as JSON',
      'it is of other--uat.sandbox.my.salesforce.com, not of the host its folder names',
      'its name is not one --save gives',
    ]);
  });

  it('of another host are never read for this one', async () => {
    const dir = journal();
    await saveInventory(dir, inventory({ host: 'other--uat.sandbox.my.salesforce.com' }));
    const read = await readInventories(dir, HOST);
    expect(read.kept).toEqual([]);
    expect(read.unread).toBeUndefined();
  });

  it('are none where a file stands for their folder, and none for what is no host', async () => {
    const dir = journal();
    mkdirSync(join(dir, 'audits'), { recursive: true });
    writeFileSync(join(dir, 'audits', HOST), 'a file where the folder goes');
    const read = await readInventories(dir, HOST);
    expect(read.kept).toEqual([]);
    expect(read.unread).toBeUndefined();
    const notAHost = await readInventories(dir, 'not a host');
    expect(notAHost.unread).toBe('not a host is not a host name');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'say why when their folder cannot be read, and none is taken',
    async () => {
      const dir = journal();
      await saveInventory(dir, inventory());
      const folder = join(dir, 'audits', HOST);
      chmodSync(folder, 0o000);
      try {
        const read = await readInventories(dir, HOST);
        expect(read.kept).toEqual([]);
        expect(read.unread).toMatch(/could not be read: EACCES/);
      } finally {
        chmodSync(folder, 0o700);
      }
    },
  );
});

describe('the inventory the jobs are compared against', () => {
  const kept = (organizationId: string, savedAt: string) => ({
    inventory: inventory({ organizationId, savedAt }),
    path: `/j/${savedAt}`,
  });

  it('is the newest of the same host under another Organization Id: the sandbox before its refresh', () => {
    const against = inventoryAgainst(
      [
        kept(AFTER, '2026-11-21T08:00:00.000Z'),
        kept(BEFORE, '2026-11-18T20:00:00.000Z'),
        kept(BEFORE, '2026-11-11T20:00:00.000Z'),
      ],
      AFTER,
    );
    expect(against?.refreshed).toBe(true);
    expect(against?.kept.inventory.savedAt).toBe('2026-11-18T20:00:00.000Z');
  });

  it('is the newest of the same org when no other was kept, which says no refresh', () => {
    const against = inventoryAgainst(
      [kept(BEFORE, '2026-11-18T20:00:00.000Z'), kept(BEFORE, '2026-11-11T20:00:00.000Z')],
      `${BEFORE.slice(0, 15)}`,
    );
    expect(against?.refreshed).toBe(false);
    expect(against?.kept.inventory.savedAt).toBe('2026-11-18T20:00:00.000Z');
  });

  it('is none when nothing was kept of the host', () => {
    expect(inventoryAgainst([], AFTER)).toBeUndefined();
  });
});
