import { describe, it, expect, vi, afterEach } from 'vitest';
import { messageLines, parseArgs, removalPlanLines } from './sandforge-frozen.js';

/** A command line, as `process.argv` hands it over. */
function argv(...args: string[]): string[] {
  return ['node', 'sandforge-frozen.ts', ...args];
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** Run a parse that is meant to be refused, and report the exit. */
function refuse(...args: string[]): { code: number | undefined; message: string } {
  let code: number | undefined;
  let message = '';
  vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
    code = c;
    throw new Error('exit');
  }) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
    message += chunk;
    return true;
  }) as never);
  try {
    parseArgs(argv(...args));
  } catch {
    // `process.exit` is stubbed to throw so the parse stops where it would.
  }
  return { code, message };
}

describe('parseArgs', () => {
  it('reads a step, its configuration and the org it works on', () => {
    const args = parseArgs(argv('extract', '--config', 'frozen.json', '--source', 'SRC'));
    expect(args).toMatchObject({ step: 'extract', configPath: 'frozen.json', source: 'SRC' });
  });

  it('reads a load and its modes', () => {
    const args = parseArgs(
      argv('load', '--config', 'f.json', '--target', 'TGT', '--pilot', '--reload', '--yes'),
    );
    expect(args).toMatchObject({
      step: 'load',
      target: 'TGT',
      pilot: true,
      reload: true,
      yes: true,
    });
  });

  it('does not write without being told to, unless --yes says so', () => {
    expect(parseArgs(argv('load', '--config', 'f.json', '--target', 'TGT')).yes).toBe(false);
  });

  it('refuses a first word that is not a step', () => {
    const { code, message } = refuse('freeze', '--config', 'f.json');
    expect(code).toBe(2);
    expect(message).toContain('select, extract, load, verify, remove, status');
  });

  it('refuses a line with no configuration', () => {
    expect(refuse('status').code).toBe(2);
  });

  it('refuses a step without the org it needs', () => {
    expect(refuse('select', '--config', 'f.json').message).toContain('--source');
    expect(refuse('verify', '--config', 'f.json').message).toContain('--target');
    expect(refuse('remove', '--config', 'f.json').message).toContain('--target');
  });

  it('reads a removal, which keeps what changed since the load unless told otherwise', () => {
    expect(parseArgs(argv('remove', '--config', 'f.json', '--target', 'TGT'))).toMatchObject({
      step: 'remove',
      target: 'TGT',
      includeChanged: false,
      yes: false,
    });
    expect(
      parseArgs(argv('remove', '--config', 'f.json', '--target', 'TGT', '--include-changed'))
        .includeChanged,
    ).toBe(true);
  });
});

describe('removalPlanLines', () => {
  it('names the org, what the removal takes per object in its order, and what stays', () => {
    expect(
      removalPlanLines(
        {
          orgId: '00D000000000001AAA',
          loadedAt: '2026-09-24T10:05:00.000Z',
          created: [
            { objectApiName: 'Contact', count: 2 },
            { objectApiName: 'Account', count: 1 },
          ],
          linked: 4,
          recorded: true,
        },
        'TGT',
      ),
    ).toEqual([
      'the last load wrote to TGT at 2026-09-24T10:05:00.000Z; a removal deletes the 3 record(s) it created, children first:',
      '  Contact: 2',
      '  Account: 1',
      '4 record(s) it linked to or reused stay',
    ]);
  });

  it('says when the load it takes is one before the last', () => {
    expect(
      removalPlanLines(
        {
          orgId: '00D000000000001AAA',
          loadedAt: '2026-09-23T10:05:00.000Z',
          created: [{ objectApiName: 'Account', count: 1 }],
          linked: 0,
          recorded: true,
          earlier: true,
        },
        'TGT',
      )[0],
    ).toBe(
      'a load before the last one, whose records the loads after it left in place, wrote to TGT at 2026-09-23T10:05:00.000Z; a removal deletes the 1 record(s) it created, children first:',
    );
  });
});

describe('messageLines', () => {
  it('says what a removal did per object, with the reasons the org gave', () => {
    const outcome = {
      planned: 0,
      deleted: 0,
      alreadyGone: 0,
      keptChanged: 0,
      keptDependents: 0,
      refused: 0,
      heldBy: [],
      unchecked: [],
      reasons: [],
    };
    const lines = messageLines({
      type: 'frozen:remove:response',
      payload: {
        operationId: 'frozen-remove-1',
        result: {
          status: 'partial',
          includeChanged: false,
          finishedAt: '2026-09-24T11:00:00.000Z',
          objects: [
            { ...outcome, objectApiName: 'Contact', planned: 3, deleted: 2, alreadyGone: 1 },
            {
              ...outcome,
              objectApiName: 'Account',
              planned: 1,
              keptDependents: 1,
              heldBy: ['Case'],
              unchecked: ['ActionableListMember'],
            },
            {
              ...outcome,
              objectApiName: 'Order',
              planned: 1,
              refused: 1,
              reasons: ['DELETE_FAILED: activated order'],
            },
          ],
        },
      },
    });

    expect(lines).toEqual([
      'removal: PARTIAL',
      '  Contact: 2 deleted, 1 already gone of 3',
      '  Account: 1 kept for records that stay (Case) of 1',
      '  Order: 1 refused of 1',
      '      DELETE_FAILED: activated order',
      'not checked, deleted with their parent: ActionableListMember',
    ]);
  });

  it('names what a load left to the platform after the objects it wrote', () => {
    const lines = messageLines({
      type: 'frozen:load:response',
      payload: {
        report: {
          status: 'completed',
          durationMs: 5,
          alignment: { excludedObjects: [], removals: [], recordTypeIssues: [] },
          placeholders: [],
          perObject: [
            {
              objectApiName: 'FeedItem',
              fromFiles: 2,
              inserted: 1,
              reused: 0,
              skippedDuplicates: [],
              failed: [],
            },
          ],
          pass2: { resolved: 0, unresolved: [] },
          purge: { deleted: {}, failures: [] },
          leftToThePlatform: [
            {
              objectApiName: 'FeedItem',
              note: '1 tracked change left out: the platform writes them itself',
            },
          ],
        },
      },
    });

    expect(lines).toEqual([
      'load: completed in 5ms — 0 object(s) excluded, 0 field removal(s), 0 record type issue(s), 0 placeholder(s)',
      '  FeedItem: 1 inserted, 0 reused, 0 duplicate(s), 0 failed of 2',
      '  FeedItem: 1 tracked change left out: the platform writes them itself',
      'pass 2: 0 resolved, 0 unresolved',
    ]);
  });

  it('names each object a load did not send, with why, and the feed items it could not type', () => {
    const lines = messageLines({
      type: 'frozen:load:response',
      payload: {
        report: {
          status: 'completed-with-errors',
          durationMs: 5,
          alignment: {
            excludedObjects: [
              {
                objectApiName: 'RevenueTransactionErrorLog',
                reason: 'Not createable in target org: 1 record of the dataset not loaded',
              },
            ],
            removals: [],
            recordTypeIssues: [],
          },
          placeholders: [],
          perObject: [],
          pass2: { resolved: 0, unresolved: [] },
          purge: { deleted: {}, failures: [] },
          untypedFeedItems: [
            {
              objectApiName: 'FeedItem',
              note: '1 feed item left out: the dataset does not carry its type',
            },
          ],
        },
      },
    });

    expect(lines).toEqual([
      'load: completed-with-errors in 5ms — 1 object(s) excluded, 0 field removal(s), 0 record type issue(s), 0 placeholder(s)',
      '  RevenueTransactionErrorLog: not loaded — Not createable in target org: 1 record of the dataset not loaded',
      '  FeedItem: 1 feed item left out: the dataset does not carry its type',
      'pass 2: 0 resolved, 0 unresolved',
    ]);
  });

  it('says what a reload purged, and what it left of a load that did not say what it created', () => {
    const lines = messageLines({
      type: 'frozen:load:response',
      payload: {
        report: {
          status: 'completed',
          durationMs: 5,
          alignment: { excludedObjects: [], removals: [], recordTypeIssues: [] },
          placeholders: [],
          perObject: [],
          pass2: { resolved: 0, unresolved: [] },
          purge: {
            deleted: { Contact: 2, Account: 1 },
            failures: [],
            leftUnrecorded: { Product2: 3, ProductSellingModel: 1 },
          },
        },
      },
    });

    expect(lines.slice(-4)).toEqual([
      'purge of earlier loads: 3 deleted, 0 deactivated, 0 failed',
      'left in place, of a load recorded before loads kept what they created — it may have linked them:',
      '  Product2: 3',
      '  ProductSellingModel: 1',
    ]);
  });

  it('counts what a reload deactivated beside what it deleted, and a purge that only deactivated', () => {
    // What the target lets no one delete, the purge deactivates: counted as
    // deleted only, a purge that took nothing else printed no line at all.
    const purgeLines = (purge: Record<string, unknown>): string[] =>
      messageLines({
        type: 'frozen:load:response',
        payload: {
          report: {
            status: 'completed',
            durationMs: 5,
            alignment: { excludedObjects: [], removals: [], recordTypeIssues: [] },
            placeholders: [],
            perObject: [],
            pass2: { resolved: 0, unresolved: [] },
            purge,
          },
        },
      }).filter((line) => line.startsWith('purge of earlier loads'));

    expect(
      purgeLines({
        deleted: { Contact: 2 },
        deactivated: { Product2: 1, ProductSellingModel: 2 },
        failures: [],
      }),
    ).toEqual(['purge of earlier loads: 2 deleted, 3 deactivated, 0 failed']);
    expect(purgeLines({ deleted: {}, deactivated: { Product2: 1 }, failures: [] })).toEqual([
      'purge of earlier loads: 0 deleted, 1 deactivated, 0 failed',
    ]);
    expect(purgeLines({ deleted: {}, deactivated: {}, failures: [] })).toEqual([]);
  });

  it('says how many person accounts a load gave their contact back, and why the others kept none', () => {
    // The Load tab says both; the command said neither.
    const personContactLines = (personContact: Record<string, unknown>): string[] =>
      messageLines({
        type: 'frozen:load:response',
        payload: {
          report: {
            status: 'completed-with-errors',
            durationMs: 5,
            alignment: { excludedObjects: [], removals: [], recordTypeIssues: [] },
            placeholders: [],
            perObject: [],
            pass2: { resolved: 0, unresolved: [] },
            personContact,
            purge: { deleted: {}, failures: [] },
          },
        },
      }).filter((line) => !line.startsWith('load: ') && !line.startsWith('pass 2: '));

    expect(
      personContactLines({
        restored: 2,
        unresolved: [
          {
            accountReferenceId: 'Account-000003',
            contactReferenceId: 'Contact-000003',
            cause: 'target-not-loaded',
            detail: 'contact Contact-000003 was not loaded (skipped, failed or excluded)',
          },
          {
            accountReferenceId: 'Account-000004',
            contactReferenceId: 'Contact-000004',
            cause: 'update-refused',
            detail:
              'INVALID_FIELD_FOR_INSERT_UPDATE: Unable to create/update fields: PersonContactId',
          },
        ],
      }),
    ).toEqual([
      'PersonContact: 2 restored, 2 unresolved',
      '  Account.PersonContactId: contact Contact-000003 was not loaded (skipped, failed or excluded)',
      '  Account.PersonContactId: INVALID_FIELD_FOR_INSERT_UPDATE: Unable to create/update fields: PersonContactId',
    ]);
    // A dataset with no person account has no link to give back.
    expect(personContactLines({ restored: 0, unresolved: [] })).toEqual([]);
  });

  it('names what an extraction left to the platform, object by object', () => {
    const lines = messageLines({
      type: 'frozen:extract:response',
      payload: {
        recordCount: 3,
        datasetDir: '/sas/dataset',
        manifest: {
          version: '1.0.0',
          volumetry: { measured: { Opportunity: 1, FeedItem: 1, FeedComment: 1 } },
          coverage: {
            objects: 3,
            truncated: false,
            maxNodes: 50,
            unboundedObjects: [],
            filesLeftOut: [],
            leftToThePlatform: [
              {
                objectApiName: 'FeedItem',
                count: 1,
                note: '1 tracked change left out: the platform writes them itself',
              },
              {
                objectApiName: 'FeedComment',
                count: 1,
                note: '1 left out: FeedItemId names a tracked change, which the platform writes itself',
              },
            ],
          },
        },
      },
    });

    expect(lines).toEqual([
      'frozen 3 record(s) as version 1.0.0 in /sas/dataset',
      'graph: 3 object(s) at a cap of 50',
      'FeedItem: 1 tracked change left out: the platform writes them itself',
      'FeedComment: 1 left out: FeedItemId names a tracked change, which the platform writes itself',
      '  Opportunity: 1',
      '  FeedItem: 1',
      '  FeedComment: 1',
    ]);
  });

  it('says the cap was raised when discovery reached more objects than it', () => {
    // Twice the cap: the parents their records cannot be written without took
    // discovery past it, and the bare count read as the cap not holding.
    const lines = messageLines({
      type: 'frozen:extract:response',
      payload: {
        recordCount: 1,
        datasetDir: '/sas/dataset',
        manifest: {
          version: '1.0.0',
          volumetry: { measured: { Opportunity: 1 } },
          coverage: {
            objects: 100,
            truncated: true,
            maxNodes: 50,
            unboundedObjects: [],
            filesLeftOut: [],
          },
        },
      },
    });

    expect(lines).toContain(
      'graph: 100 object(s) at a cap of 50 (raised for the parents their records cannot be ' +
        'written without) — TRUNCATED: objects further out were not read',
    );
  });

  it('names what the objects excludedObjects leaves out cost the records the dataset holds', () => {
    const lines = messageLines({
      type: 'frozen:extract:response',
      payload: {
        recordCount: 5,
        datasetDir: '/sas/dataset',
        manifest: {
          version: '1.0.0',
          volumetry: { measured: { Opportunity: 1, OpportunityLineItem: 3, Order: 1 } },
          coverage: {
            objects: 50,
            truncated: true,
            maxNodes: 50,
            unboundedObjects: [],
            filesLeftOut: [],
            exclusionCosts: [
              {
                objectApiName: 'OpportunityLineItem',
                excludedObject: 'PricebookEntry',
                count: 3,
                note:
                  '3 OpportunityLineItem records cannot be loaded without the PricebookEntry ' +
                  'their PricebookEntryId names, which excludedObjects leaves out',
              },
            ],
          },
        },
      },
    });

    expect(lines).toContain(
      'OpportunityLineItem: 3 OpportunityLineItem records cannot be loaded without the ' +
        'PricebookEntry their PricebookEntryId names, which excludedObjects leaves out',
    );
  });
});
