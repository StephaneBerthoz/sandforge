import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  messageLines,
  parseArgs,
  removalAsks,
  removalPlanLines,
  typeOrg,
} from './sandforge-frozen.js';

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

  it('reads a dry run of a load, which writes nothing', () => {
    expect(
      parseArgs(argv('load', '--config', 'f.json', '--target', 'TGT', '--dry-run', '--reload')),
    ).toMatchObject({ step: 'load', dryRun: true, reload: true });
    expect(parseArgs(argv('load', '--config', 'f.json', '--target', 'TGT')).dryRun).toBe(false);
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

describe('typeOrg', () => {
  /** A connection whose Organization record answers `row`, and whose edition query answers `edition`. */
  function orgAnswering(row: { Id: string; IsSandbox: boolean }, edition: () => unknown) {
    const query = vi.fn(async (soql: string) =>
      soql.includes('OrganizationType') ? { records: [edition()] } : { records: [row] },
    );
    return { query, conn: { query } as never };
  }

  it('gives a Developer Edition org its edition, which the guards of the load read', async () => {
    // Typed from IsSandbox alone, it was registered as a production org with
    // no edition, and every guard of the load refused it.
    const { conn } = orgAnswering({ Id: '00D000000000001AAA', IsSandbox: false }, () => ({
      OrganizationType: 'Developer Edition',
    }));

    await expect(typeOrg(conn)).resolves.toEqual({
      id: '00D000000000001AAA',
      orgType: 'Production',
      edition: 'Developer Edition',
    });
  });

  it('types a sandbox from IsSandbox, without asking its edition', async () => {
    const { conn, query } = orgAnswering({ Id: '00D000000000002AAA', IsSandbox: true }, () => ({
      OrganizationType: 'Enterprise Edition',
    }));

    await expect(typeOrg(conn)).resolves.toEqual({
      id: '00D000000000002AAA',
      orgType: 'Sandbox',
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('leaves an org whose edition cannot be read a production org without one', async () => {
    const { conn } = orgAnswering({ Id: '00D000000000003AAA', IsSandbox: false }, () => {
      throw new Error('INVALID_FIELD');
    });

    await expect(typeOrg(conn)).resolves.toEqual({
      id: '00D000000000003AAA',
      orgType: 'Production',
    });
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

describe('removalPlanLines, once a removal left records in the org', () => {
  /** The last load, after a removal that kept its two orders and what hangs from them. */
  const left = {
    orgId: '00D000000000001AAA',
    loadedAt: '2026-09-29T15:49:35.673Z',
    created: [
      { objectApiName: 'OrderItem', count: 6 },
      { objectApiName: 'Order', count: 2 },
      { objectApiName: 'Account', count: 1 },
    ],
    linked: 4,
    recorded: true,
    removed: { removedAt: '2026-09-29T15:51:27.295Z' },
  };

  it('names what the removal left as what the next one deletes', () => {
    expect(removalPlanLines(left, 'TGT')).toEqual([
      'the last load wrote to TGT at 2026-09-29T15:49:35.673Z; the removal of 2026-09-29T15:51:27.295Z left 9 of the records it created, and a removal deletes those, children first:',
      '  OrderItem: 6',
      '  Order: 2',
      '  Account: 1',
      '4 record(s) it linked to or reused stay',
    ]);
  });

  it('says none is left once the removal took them all', () => {
    expect(removalPlanLines({ ...left, created: [] }, 'TGT')[0]).toBe(
      'the last load wrote to TGT at 2026-09-29T15:49:35.673Z; its records were removed on 2026-09-29T15:51:27.295Z, and none is left to remove',
    );
  });
});

describe('removalAsks', () => {
  const loaded = {
    orgId: '00D000000000001AAA',
    loadedAt: '2026-09-29T15:49:35.673Z',
    created: [{ objectApiName: 'Account', count: 1 }],
    linked: 0,
    recorded: true,
  };

  it('asks before deleting what the load created, or what a removal left of it', () => {
    expect(removalAsks(loaded)).toBe(true);
    expect(removalAsks({ ...loaded, removed: { removedAt: '2026-09-29T15:51:27.295Z' } })).toBe(
      true,
    );
  });

  it('does not ask when the handler will refuse: nothing left, or nothing recorded', () => {
    expect(
      removalAsks({
        ...loaded,
        created: [],
        removed: { removedAt: '2026-09-29T15:51:27.295Z' },
      }),
    ).toBe(false);
    expect(removalAsks({ ...loaded, created: [], recorded: false })).toBe(false);
  });
});

describe('messageLines', () => {
  it('says what a dry run of a load found, per object, and that nothing was written', () => {
    const lines = messageLines({
      type: 'frozen:load:preview:response',
      payload: {
        plan: {
          orgId: 'org-dev',
          mode: { pilot: false, reload: true },
          plannedAt: '2026-10-09T10:00:00.000Z',
          perObject: [
            {
              objectApiName: 'Account',
              fromFiles: 3,
              toInsert: 1,
              reusedByKeys: 2,
              reusedFromCatalog: 0,
              fieldsDropped: 1,
              picklistsRewritten: 0,
              notSent: 0,
              toPurge: 4,
              toDeactivate: 0,
            },
            {
              objectApiName: 'Pricebook2',
              fromFiles: 1,
              toInsert: 0,
              reusedByKeys: 0,
              reusedFromCatalog: 1,
              fieldsDropped: 0,
              picklistsRewritten: 2,
              notSent: 0,
              toPurge: 0,
              toDeactivate: 0,
            },
          ],
          excludedObjects: [
            { objectApiName: 'ErrorLog__c', reason: 'Not createable in target org' },
          ],
          removals: [],
          placeholders: [
            {
              objectApiName: 'Contact',
              field: 'Owner__c',
              placeholderObjectApiName: 'User__c',
              placeholderName: 'SANDFORGE-PLACEHOLDER',
              affectedRecords: 2,
            },
          ],
          requiredDefaults: [],
          recordTypeIssues: 0,
          personContacts: 1,
          earlierLoads: 2,
        },
      },
    });

    expect(lines).toEqual([
      'dry run (reload): 1 record(s) to insert, 3 to link, 0 not sent, 4 to purge and 0 to deactivate of 2 earlier load(s) — nothing written',
      '  Account: 1 to insert, 2 found by identity keys, 1 field(s) dropped, 4 to purge of 3',
      '  Pricebook2: 0 to insert, 1 found in the catalog, 2 picklist value(s) rewritten of 1',
      '  ErrorLog__c: not loaded — Not createable in target org',
      'placeholder for Contact.Owner__c: 2 record(s)',
      '1 person account contact(s) go in with their account, not counted above',
    ]);
  });

  it('says a removal took up what an earlier one left', () => {
    const lines = messageLines({
      type: 'frozen:remove:response',
      payload: {
        operationId: 'frozen-remove-2',
        result: {
          status: 'success',
          includeChanged: true,
          finishedAt: '2026-09-29T16:10:00.000Z',
          leftBy: '2026-09-29T15:51:27.295Z',
          objects: [
            {
              objectApiName: 'Order',
              planned: 2,
              deleted: 2,
              alreadyGone: 0,
              keptChanged: 0,
              keptDependents: 0,
              refused: 0,
              heldBy: [],
              unchecked: [],
              reasons: [],
            },
          ],
        },
      },
    });

    expect(lines).toEqual([
      'removal: SUCCESS — of what the removal of 2026-09-29T15:51:27.295Z left',
      '  Order: 2 deleted of 2',
    ]);
  });

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

  it('names the files attached to the records a removal deleted, which stay in the org', () => {
    const lines = messageLines({
      type: 'frozen:remove:response',
      payload: {
        operationId: 'frozen-remove-1',
        result: {
          status: 'success',
          includeChanged: true,
          finishedAt: '2026-09-24T11:00:00.000Z',
          objects: [
            {
              objectApiName: 'Order',
              planned: 2,
              deleted: 2,
              alreadyGone: 0,
              keptChanged: 0,
              keptDependents: 0,
              refused: 0,
              heldBy: [],
              unchecked: [],
              reasons: [],
              filesLeft: { count: 2, names: ['Confirmation-0001.pdf', 'Confirmation-0002.pdf'] },
            },
          ],
        },
      },
    });

    expect(lines).toEqual([
      'removal: SUCCESS',
      '  Order: 2 deleted of 2',
      '      2 file(s) attached to them stay in the org, as the load did not create them: Confirmation-0001.pdf, Confirmation-0002.pdf',
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

  it('names each field the target refused records on that went in written again, with what refused it', () => {
    // The Load tab said them, and the command said none: a record in the
    // target short of a value the dataset held read as one written whole.
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
              objectApiName: 'Account',
              fromFiles: 3,
              inserted: 3,
              reused: 0,
              skippedDuplicates: [],
              failed: [],
              writtenWithoutFields: {
                rows: 2,
                fields: [
                  {
                    field: 'Tier__c',
                    refusedBy: 'restricted-picklist',
                    reason: 'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST: bad value: Gold',
                    rows: 1,
                    replacedWith: 'Silver',
                  },
                  {
                    field: 'Phone',
                    refusedBy: 'validation-rule',
                    reason: 'FIELD_CUSTOM_VALIDATION_EXCEPTION: Phone must be written +33…',
                    rows: 1,
                  },
                ],
              },
            },
          ],
          pass2: { resolved: 0, unresolved: [] },
          purge: { deleted: {}, failures: [] },
        },
      },
    });

    expect(lines).toEqual([
      'load: completed in 5ms — 0 object(s) excluded, 0 field removal(s), 0 record type issue(s), 0 placeholder(s)',
      '  Account: 3 inserted, 0 reused, 0 duplicate(s), 0 failed of 3',
      'written again without a field a validation rule or a restricted picklist refused (1 object(s)):',
      '  Account.Tier__c  1 record(s) — a restricted picklist refused its value — written with ' +
        '"Silver", as its picklist rule declares — INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST: bad value: Gold',
      '  Account.Phone  1 record(s) — a validation rule refused it — ' +
        'FIELD_CUSTOM_VALIDATION_EXCEPTION: Phone must be written +33…',
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

  it("says how many person accounts' contacts a load linked to the platform's, and why it linked none of the others", () => {
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
        sent: [
          {
            accountReferenceId: 'Account-000004',
            contactReferenceId: 'Contact-000004',
            detail:
              "the target holds the account as a business account, which takes the contact as one of its own: its record type there is no person account's",
          },
        ],
        unresolved: [
          {
            accountReferenceId: 'Account-000003',
            contactReferenceId: 'Contact-000003',
            cause: 'record-not-loaded',
            detail: 'person account was not loaded (see perObject failures/skips)',
          },
        ],
      }),
    ).toEqual([
      'person contacts: 2 linked, 1 sent as contacts of their own, 1 not linked',
      "  Contact-000004 sent: the target holds the account as a business account, which takes the contact as one of its own: its record type there is no person account's",
      '  Contact-000003: person account was not loaded (see perObject failures/skips)',
    ]);
    // A dataset with no person account has no contact to link.
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
