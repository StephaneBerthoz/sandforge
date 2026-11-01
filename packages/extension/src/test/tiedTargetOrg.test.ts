import { describe, expect, it } from 'vitest';

import { addSyncedQuote, tiedTargetOrg } from './tiedTargetOrg.js';

const USER = '005000000000001AAA';
const ACCOUNT = '001000000000001AAA';
const CASE = '500000000000001AAA';
const ASSET = '02i000000000001AAA';
const TASK = '00T000000000001AAA';
const NOTE = '00T000000000002AAA';
const DATE = '2026-10-15T09:00:00.000+0000';

const row = (Id: string, lookups = {}) => ({
  Id,
  Name: Id,
  CreatedById: USER,
  CreatedDate: DATE,
  LastModifiedDate: DATE,
  LastModifiedById: USER,
  SystemModstamp: DATE,
  ...lookups,
});

/** An account, its case naming an asset the org restricts, a task in cascade, a note it clears. */
function org() {
  const target = tiedTargetOrg(USER);
  target.shape('Account', {
    children: [
      { childSObject: 'Case', field: 'AccountId', cascadeDelete: true },
      { childSObject: 'Task', field: 'AccountId' },
    ],
  });
  target.shape('Case', {
    references: { AccountId: ['Account'], AssetId: ['Asset'] },
    children: [{ childSObject: 'Task', field: 'WhatId', cascadeDelete: true }],
  });
  target.shape('Asset', {
    children: [{ childSObject: 'Case', field: 'AssetId', restrictedDelete: true }],
  });
  target.shape('Task', { references: { WhatId: ['Case'], AccountId: ['Account'] } });
  target.add('Account', row(ACCOUNT));
  target.add('Case', row(CASE, { AccountId: ACCOUNT, AssetId: ASSET }));
  target.add('Asset', row(ASSET));
  target.add('Task', row(TASK, { WhatId: CASE }), row(NOTE, { AccountId: ACCOUNT }));
  return target;
}

describe('tiedTargetOrg', () => {
  it('answers a read by id at either length, and counts', async () => {
    const target = org();
    const page = await target.conn.query(
      `SELECT Id, WhatId FROM Task WHERE WhatId IN ('${CASE.slice(0, 15)}')`,
    );
    expect(page.records).toEqual([{ Id: TASK, WhatId: CASE }]);
    const counted = await target.conn.query(
      `SELECT COUNT() FROM Task WHERE CreatedById = '${USER}' AND CreatedDate >= 2026-10-15T08:00:00Z AND CreatedDate <= 2026-10-15T10:00:00Z`,
    );
    expect(counted.totalSize).toBe(2);
  });

  it('refuses a column the object does not have, as the org does', async () => {
    const target = tiedTargetOrg(USER);
    target.shape('FeedItem', { fields: ['Id', 'CreatedById', 'CreatedDate'] });

    await expect(target.conn.query('SELECT LastModifiedById FROM FeedItem')).rejects.toThrow(
      /No such column 'LastModifiedById' on entity 'FeedItem'/,
    );
    await expect(target.conn.query('SELECT Id FROM Nope')).rejects.toThrow(/not supported/);
  });

  it('refuses to delete what a restricting lookup names, until the record naming it goes', async () => {
    const target = org();

    const [refused] = await target.conn.sobject('Asset').destroy([ASSET]);
    expect(refused).toMatchObject({
      success: false,
      errors: [expect.objectContaining({ statusCode: 'DELETE_FAILED' })],
    });

    await target.conn.sobject('Case').destroy([CASE]);
    const [deleted] = await target.conn.sobject('Asset').destroy([ASSET]);
    expect(deleted).toMatchObject({ success: true });
  });

  it('takes along what cascades, clears a lookup that only names the record, and keeps a recycle bin', async () => {
    const target = org();

    await target.conn.sobject('Account').destroy([ACCOUNT]);

    expect(target.ids('Case')).toEqual([]);
    expect(target.ids('Task')).toEqual([NOTE]);
    expect(target.row('Task', NOTE)?.AccountId).toBeNull();
    const gone = await target.conn.query(
      `SELECT Id FROM Case WHERE Id IN ('${CASE}') AND IsDeleted = true`,
      { scanAll: true },
    );
    expect(gone.records).toEqual([{ Id: CASE }]);
    const live = await target.conn.query(`SELECT Id FROM Case WHERE Id IN ('${CASE}')`);
    expect(live.records).toEqual([]);
    const [again] = await target.conn.sobject('Account').destroy([ACCOUNT]);
    expect(again).toMatchObject({
      success: false,
      errors: [expect.objectContaining({ statusCode: 'ENTITY_IS_DELETED' })],
    });
  });

  it('describes an object’s lookups and children, and notes its reads and writes in order', async () => {
    const target = org();

    const described = await target.conn.describe('Case');
    expect(described.fields.find((field) => field.name === 'AssetId')).toMatchObject({
      type: 'reference',
      referenceTo: ['Asset'],
    });
    expect(described.childRelationships).toEqual([
      { childSObject: 'Task', field: 'WhatId', cascadeDelete: true },
    ]);
    await target.conn.sobject('Task').destroy([NOTE]);
    await target.conn.sobject('Case').update([{ Id: CASE, Name: 'Changed' }]);

    expect(target.events).toEqual(['reads', 'write', 'write']);
    expect(target.deletes).toEqual([{ object: 'Task', ids: [NOTE] }]);
    expect(target.row('Case', CASE)?.Name).toBe('Changed');
  });

  it('holds a synced quote’s two lines, the platform’s copy beside the run’s own', async () => {
    const target = tiedTargetOrg(USER);

    const { created, copy } = addSyncedQuote(target, USER, DATE);

    expect(created.map(({ objectApiName }) => objectApiName)).toEqual([
      'Opportunity',
      'Quote',
      'OpportunityLineItem',
      'QuoteLineItem',
    ]);
    expect(target.ids('QuoteLineItem')).toHaveLength(2);
    expect(target.ids('QuoteLineItem')).toContain(copy);
    expect(created.at(-1)?.ids).not.toContain(copy);
  });

  it('runs a roll-up’s restamp when told to, and counts a composite’s subrequests', async () => {
    const target = org();
    const restamped: string[] = [];
    target.hooks.onDestroy = (object) => restamped.push(object);

    await target.conn.sobject('Task').destroy([NOTE]);
    await target.conn.request({
      url: '/composite',
      body: JSON.stringify({
        compositeRequest: [
          {
            url: `/services/data/v66.0/query?q=${encodeURIComponent('SELECT COUNT() FROM Task')}`,
            referenceId: 'a',
          },
        ],
      }),
    });

    expect(restamped).toEqual(['Task']);
    expect(target.composites).toEqual([1]);
  });
});
