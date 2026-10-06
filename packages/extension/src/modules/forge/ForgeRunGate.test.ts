import { describe, it, expect, vi } from 'vitest';
import type { ForgeTargetAutomation, ForgeTargetFlow } from '@sandforge/shared';
import {
  DEFAULT_CONFIRM_ABOVE_RECORDS,
  DEFAULT_MAX_TOTAL,
  ForgeRunGateError,
  automationRefusal,
  automationUnreadOf,
  confirmationStorageOf,
  firedOnInsertOf,
  forgeTargetTier,
  formatMB,
  insertBypassesOf,
  isDeveloperEdition,
  isForgeRunGateError,
  readDataStorage,
  rowStorageBytes,
  storageCheckOf,
  storageRefusal,
  writePlanLines,
  writePlanOf,
} from './ForgeRunGate.js';

const KB = 1024;
const MB = 1024 * KB;

/** `n` rows of an object, as the run holds them. */
const rows = (n: number, row: Record<string, unknown> = {}): Record<string, unknown>[] =>
  Array.from({ length: n }, (_, i) => ({ Id: `row-${i}`, ...row }));

describe('the data storage a row takes, by the sizes Salesforce documents', () => {
  it('counts most records at 2 KB whatever their fields hold', () => {
    expect(rowStorageBytes('Opportunity', { Name: 'x'.repeat(5_000) })).toBe(2 * KB);
    expect(rowStorageBytes('Custom__c', {})).toBe(2 * KB);
    expect(rowStorageBytes('Account', { Name: 'Acme' })).toBe(2 * KB);
  });

  it('counts a person account at 4 KB, and its contact at nothing more', () => {
    expect(rowStorageBytes('Account', { IsPersonAccount: true })).toBe(4 * KB);
    expect(rowStorageBytes('Contact', { IsPersonAccount: true })).toBe(0);
    expect(rowStorageBytes('Contact', { IsPersonAccount: false })).toBe(2 * KB);
  });

  it('counts a campaign at 8 KB and a campaign member at 1 KB', () => {
    expect(rowStorageBytes('Campaign', {})).toBe(8 * KB);
    expect(rowStorageBytes('CampaignMember', {})).toBe(1 * KB);
  });

  it('counts an article at 4 KB and the long text it holds besides', () => {
    expect(rowStorageBytes('Knowledge__kav', { Title: 'Reset a password' })).toBe(4 * KB);
    expect(rowStorageBytes('Knowledge__kav', { Title: 'T', Body__c: 'é'.repeat(1_000) })).toBe(
      4 * KB + 2_000,
    );
  });

  it('counts an email message at its actual size', () => {
    expect(
      rowStorageBytes('EmailMessage', { Subject: 'Hello', TextBody: 'é'.repeat(10), Id: 'x' }),
    ).toBe(5 + 20 + 1);
  });
});

describe('the tier a run takes its target for', () => {
  it('takes a Developer Edition org, registered as production, for a development org', () => {
    expect(forgeTargetTier('Production', 'Developer Edition')).toBe('development');
    expect(isDeveloperEdition(' developer edition ')).toBe(true);
  });

  it('keeps every other production org, and one of unknown edition, production', () => {
    expect(forgeTargetTier('Production', 'Enterprise Edition')).toBe('production');
    expect(forgeTargetTier('Production', '')).toBe('production');
    expect(forgeTargetTier('Production', undefined)).toBe('production');
    expect(forgeTargetTier('', 'Developer Edition')).toBe('development');
    expect(forgeTargetTier('', undefined)).toBe('production');
  });

  it('leaves sandboxes and scratch orgs as the guard tiers them', () => {
    expect(forgeTargetTier('Sandbox', 'Enterprise Edition')).toBe('development');
    expect(forgeTargetTier('Scratch', undefined)).toBe('scratch');
  });
});

describe('writePlanOf', () => {
  it('counts the rows to write per object, the most first, and in all', () => {
    const plan = writePlanOf([
      { objectApiName: 'Account', rows: rows(2) },
      { objectApiName: 'Contact', rows: rows(5) },
      { objectApiName: 'Case', rows: [] },
      { objectApiName: 'Campaign', rows: rows(2) },
    ]);

    expect(plan.objects.map(({ objectApiName, rows: n }) => [objectApiName, n])).toEqual([
      ['Contact', 5],
      ['Account', 2],
      ['Campaign', 2],
    ]);
    expect(plan.totalRows).toBe(9);
    expect(plan.storageBytes).toBe(7 * 2 * KB + 2 * 8 * KB);
  });
});

describe('readDataStorage', () => {
  it('reads the data storage the org says it has, from its limits', async () => {
    const request = vi.fn().mockResolvedValue({
      DataStorageMB: { Max: 200, Remaining: 37 },
      FileStorageMB: { Max: 1_000, Remaining: 900 },
    });

    await expect(readDataStorage({ request })).resolves.toEqual({ maxMB: 200, remainingMB: 37 });
    expect(request).toHaveBeenCalledWith({ method: 'GET', url: '/limits' });
  });

  it('refuses an answer that does not say it, rather than taking it for enough', async () => {
    await expect(readDataStorage({ request: vi.fn().mockResolvedValue({}) })).rejects.toThrow();
    await expect(
      readDataStorage({ request: vi.fn().mockResolvedValue({ DataStorageMB: { Max: 200 } }) }),
    ).rejects.toThrow();
  });
});

describe('storageCheckOf', () => {
  const plan = (megabytes: number) => ({ storageBytes: megabytes * MB });

  it('fits under 80 % of what the target has left', () => {
    expect(storageCheckOf(plan(8), { maxMB: 200, remainingMB: 10 }).verdict).toBe('fits');
  });

  it('comes near past 80 % of it, which a load leaves less of than the org says', () => {
    expect(storageCheckOf(plan(8.5), { maxMB: 200, remainingMB: 10 }).verdict).toBe('near');
  });

  it('exceeds past what is left, and on an org already over its allocation', () => {
    expect(storageCheckOf(plan(10.5), { maxMB: 200, remainingMB: 10 }).verdict).toBe('exceeds');
    expect(storageCheckOf(plan(0.01), { maxMB: 200, remainingMB: -4 }).verdict).toBe('exceeds');
  });

  it('says why it could not tell, and keeps the estimate', () => {
    expect(storageCheckOf(plan(2), { unread: 'INSUFFICIENT_ACCESS' })).toEqual({
      verdict: 'unread',
      estimateMB: 2,
      unread: 'INSUFFICIENT_ACCESS',
    });
  });

  it('gives the confirmation what it says of each', () => {
    expect(confirmationStorageOf(storageCheckOf(plan(9), { maxMB: 200, remainingMB: 10 }))).toEqual(
      { estimateMB: 9, maxMB: 200, remainingMB: 10, near: true },
    );
    expect(confirmationStorageOf(storageCheckOf(plan(1), { unread: 'refused' }))).toEqual({
      estimateMB: 1,
      unread: 'refused',
    });
  });
});

describe('formatMB', () => {
  it('rounds an estimate up, to two decimals under 10 MB', () => {
    expect(formatMB(0)).toBe('0');
    expect(formatMB(74 / 1024)).toBe('0.08');
    expect(formatMB(0.0001)).toBe('0.01');
    expect(formatMB(66.81)).toBe('66.9');
  });

  it('keeps a value the float holds a hair above its decimal at that decimal', () => {
    // 4.69 × 100 is 469.00000000000006 in floating point.
    expect(formatMB(4.69)).toBe('4.69');
    expect(formatMB(12.3)).toBe('12.3');
  });
});

describe('what fires as a run inserts', () => {
  const flow = (over: Partial<ForgeTargetFlow>): ForgeTargetFlow => ({
    apiName: 'F',
    label: 'F',
    timing: 'afterSave',
    startsOn: 'create',
    condition: 'read',
    permissions: [],
    ...over,
  });
  const automation: ForgeTargetAutomation = {
    objectsRead: ['Contact', 'Case', 'Account'],
    objects: [
      {
        objectApiName: 'Contact',
        flows: [
          flow({
            label: 'Contact welcome',
            permissions: [{ name: 'Load_Data', bypass: true }],
          }),
          flow({ label: 'Contact updated', startsOn: 'update', permissions: [] }),
          flow({
            label: 'Contact audit',
            startsOn: 'update',
            permissions: [{ name: 'Skip_Audit', bypass: true }],
          }),
        ],
        triggers: [],
      },
      {
        objectApiName: 'Case',
        flows: [],
        triggers: [{ name: 'CaseTrigger', events: ['beforeInsert', 'afterUpdate'] }],
      },
      {
        objectApiName: 'Account',
        flows: [],
        triggers: [{ name: 'AccountCleanup', events: ['afterDelete'] }],
      },
    ],
    unread: [
      { part: 'conditions', reason: 'MALFORMED_QUERY' },
      { part: 'triggers', reason: 'INSUFFICIENT_ACCESS: the Tooling API is off' },
    ],
    conditionsNotRead: 0,
    conditionsBound: 25,
    requests: 4,
  };

  it('names each flow and trigger that fires on insert, with its object and kind', () => {
    expect(firedOnInsertOf(automation)).toEqual([
      { objectApiName: 'Contact', kind: 'flow', name: 'Contact welcome' },
      { objectApiName: 'Case', kind: 'trigger', name: 'CaseTrigger' },
    ]);
  });

  it('names the permissions that keep a flow firing on insert quiet, and no other', () => {
    expect(insertBypassesOf(automation)).toEqual(['Load_Data']);
  });

  it('says what could not be read of what fires, a start condition aside', () => {
    expect(automationUnreadOf(automation)).toEqual([
      { part: 'triggers', reason: 'INSUFFICIENT_ACCESS: the Tooling API is off' },
    ]);
  });

  it('gives the command line the reason it refuses to write, naming the automation', () => {
    expect(automationRefusal(automation, 'TGT')).toBe(
      'TGT runs automation on the records this clone inserts: Contact: flow "Contact welcome"; ' +
        'Case: Apex trigger CaseTrigger. The Apex triggers of TGT could not be read ' +
        '(INSUFFICIENT_ACCESS: the Tooling API is off), so what fires as the clone inserts is ' +
        'not known. Nothing was written. Add --accept-automation to clone all the same, or turn ' +
        'that automation off in TGT first.',
    );
  });

  it('gives it none when nothing fires on insert and everything was read', () => {
    expect(
      automationRefusal(
        { objects: [automation.objects[2]], unread: [{ part: 'conditions', reason: 'x' }] },
        'TGT',
      ),
    ).toBeUndefined();
  });
});

describe('ForgeRunGateError', () => {
  it('tells the page why the run stopped, and the storage of a refusal for storage', () => {
    expect(new ForgeRunGateError('WRITE_DECLINED', 'cancelled').stop).toEqual({
      code: 'WRITE_DECLINED',
    });
    expect(
      new ForgeRunGateError('STORAGE_EXCEEDED', 'full', { estimateMB: 70, remainingMB: 12 }).stop,
    ).toEqual({ code: 'STORAGE_EXCEEDED', storage: { estimateMB: 70, remainingMB: 12 } });
    // The command line's own refusals never reach the page.
    expect(new ForgeRunGateError('MAX_TOTAL_EXCEEDED', 'too many').stop).toBeUndefined();
  });

  it('is told by its name as well as its class', () => {
    const lookalike = Object.assign(new Error('cancelled'), {
      name: 'ForgeRunGateError',
      code: 'WRITE_DECLINED',
    });
    expect(isForgeRunGateError(new ForgeRunGateError('WRITE_DECLINED', 'cancelled'))).toBe(true);
    expect(isForgeRunGateError(lookalike)).toBe(true);
    expect(isForgeRunGateError(new Error('cancelled'))).toBe(false);
  });
});

describe('what the gate says', () => {
  const plan = writePlanOf([
    { objectApiName: 'Contact', rows: rows(30) },
    { objectApiName: 'Account', rows: rows(4) },
  ]);

  it('refuses rows that take more storage than the target has left, saying both', () => {
    const check = storageCheckOf({ storageBytes: 70 * MB }, { maxMB: 200, remainingMB: 12 });
    expect(storageRefusal(check, 'TGT')).toBe(
      'The records to write take about 70 MB of data storage, and TGT has 12 MB left of 200 MB: ' +
        'leave objects out, lower the records per object, or free data storage in TGT.',
    );
    expect(storageRefusal(storageCheckOf(plan, { maxMB: 200, remainingMB: 12 }), 'TGT')).toBe(
      undefined,
    );
  });

  it('lists the records per object and the storage on the command line', () => {
    expect(
      writePlanLines(plan, storageCheckOf(plan, { maxMB: 200, remainingMB: 12 }), 'TGT'),
    ).toEqual([
      'write gate: 34 record(s) to write to TGT, about 0.07 MB of data storage',
      `  ${'Contact'.padEnd(42)}${'30'.padStart(8)}`,
      `  ${'Account'.padEnd(42)}${'4'.padStart(8)}`,
      '  data storage of TGT: 12 MB left of 200 MB',
    ]);
  });

  it('says when the storage comes near what is left, or could not be read', () => {
    const near = writePlanLines(plan, storageCheckOf(plan, { maxMB: 1, remainingMB: 0.08 }), 'T');
    expect(near.at(-1)).toBe(
      '  that is more than 80 % of what T has left: Salesforce counts storage a while after a ' +
        'load, so less may be left than it says',
    );
    const unread = writePlanLines(plan, storageCheckOf(plan, { unread: 'refused' }), 'T');
    expect(unread.at(-1)).toBe(
      '  the data storage T has left could not be read (refused): whether the records fit is not known',
    );
  });

  it('asks above 2 000 records in the extension, and refuses above 10 000 on the command line', () => {
    expect(DEFAULT_CONFIRM_ABOVE_RECORDS).toBe(2_000);
    expect(DEFAULT_MAX_TOTAL).toBe(10_000);
  });
});
