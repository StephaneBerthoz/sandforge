import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MemoryRemovalOrg } from '../../test/memoryRemovalOrg.js';
import { compositeReader } from './compositeQueries.js';
import { keepPointing, keptPointing, pointingCount } from './dependentsPointing.js';

const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

describe('pointingCount', () => {
  it('counts the relationships some record of the org points through, as the removal asks them', async () => {
    const org = new MemoryRemovalOrg();
    org.add('AccountContactRelation', { Id: id('07k', 1), ContactId: id('003', 1) });
    org.add('Case', { Id: id('500', 1), ContactId: null });

    const count = await pointingCount(compositeReader(org), [
      { childSObject: 'AccountContactRelation', field: 'ContactId' },
      { childSObject: 'Case', field: 'ContactId' },
      { childSObject: 'Task', field: 'WhoId' },
    ]);

    expect(count).toBe(1);
  });

  it('counts one the org would not answer as pointing, as the removal reads it, and asks nothing of none', async () => {
    const org = new MemoryRemovalOrg();
    const refusing = compositeReader({
      ...org,
      version: org.version,
      request: () => Promise.reject(new Error('INVALID_TYPE: sObject type is not supported')),
      query: () => Promise.reject(new Error('INVALID_TYPE: sObject type is not supported')),
      queryMore: () => Promise.reject(new Error('INVALID_TYPE')),
    });

    expect(
      await pointingCount(refusing, [{ childSObject: 'Hidden__c', field: 'Contact__c' }]),
    ).toBe(1);
    expect(await pointingCount(refusing, [])).toBe(0);
  });
});

describe('keepPointing and keptPointing', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pointing-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps per object what the preview read, for the rewind, readable by its owner alone', async () => {
    expect(await keptPointing(dir)).toEqual(new Map());

    await keepPointing(dir, new Map([['Contact', 1]]));

    expect(await keptPointing(dir)).toEqual(new Map([['Contact', 1]]));
    if (process.platform !== 'win32')
      expect(statSync(join(dir, 'dependents-pointing.json')).mode & 0o777).toBe(0o600);
  });

  it('keeps nothing when it read nothing', async () => {
    await keepPointing(dir, new Map());

    expect(await keptPointing(dir)).toEqual(new Map());
  });
});
