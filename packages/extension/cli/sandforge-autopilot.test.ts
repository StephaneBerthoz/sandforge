import { describe, it, expect, vi } from 'vitest';
import type { Connection } from 'jsforce';
import {
  contactPointLines,
  everyPage,
  outcomeLines,
  personAccountLines,
  scopeLines,
} from './sandforge-autopilot';

describe('sandforge-autopilot — what it asks of the target', () => {
  it('reads every page of the answer, not the first alone', async () => {
    // Asked of two hundred activities at a time, the target answers with
    // every relation they hold, and an event's invitees take it past a page:
    // the relations past the first were never seen, and the run wrote them
    // again for the target to refuse. The panel reads the target to its last.
    const NEXT = '/services/data/v66.0/query/01g000000000001-2000';
    const conn = {
      query: vi.fn().mockResolvedValue({
        records: [{ Id: '0RE000000000001AAA' }],
        done: false,
        nextRecordsUrl: NEXT,
      }),
      queryMore: vi.fn().mockResolvedValue({ records: [{ Id: '0RE000000000002AAA' }], done: true }),
    };

    const rows = await everyPage(conn as unknown as Connection)(
      'SELECT Id FROM EventRelation WHERE EventId IN (...)',
    );

    expect(rows).toEqual([{ Id: '0RE000000000001AAA' }, { Id: '0RE000000000002AAA' }]);
    expect(conn.queryMore).toHaveBeenCalledWith(NEXT);
  });
});

describe('sandforge-autopilot — the run summary', () => {
  const missing = "Des champs obligatoires n'ont pas été remplis : [Entity__c]";

  it('prints each object written, linked and refused, then why, by code and fields', () => {
    const lines = outcomeLines({
      totalSuccess: 1,
      totalFailure: 2,
      totalSkipped: 0,
      totalLinked: 1,
      elapsedMs: 1,
      completedObjects: ['Quote'],
      failedObjects: [],
      skippedObjects: [],
      objectOutcomes: {
        Quote: {
          written: 1,
          linked: 1,
          failed: 2,
          refusals: [
            {
              statusCode: 'REQUIRED_FIELD_MISSING',
              fields: ['Entity__c'],
              count: 2,
              message: missing,
            },
          ],
        },
      },
    });

    expect(lines).toEqual([
      `  ${'Quote'.padEnd(28)} written 1  linked 1  refused 2`,
      `      REQUIRED_FIELD_MISSING [Entity__c] x2: ${missing}`,
    ]);
  });

  it('prints the records written in another currency than they were read in, and their amounts converted', () => {
    const lines = outcomeLines({
      totalSuccess: 1,
      totalFailure: 0,
      totalSkipped: 0,
      elapsedMs: 1,
      completedObjects: ['Opportunity'],
      failedObjects: [],
      skippedObjects: [],
      objectOutcomes: {
        Opportunity: {
          written: 1,
          linked: 0,
          failed: 0,
          refusals: [],
          currenciesReplaced: [
            {
              objectApiName: 'Opportunity',
              from: 'GBP',
              to: 'USD',
              chosenBy: 'corporate',
              rows: 1,
              fields: ['Amount'],
            },
          ],
        },
      },
    });

    expect(lines).toEqual([
      `  ${'Opportunity'.padEnd(28)} written 1  linked 0  refused 0`,
      "      1 row(s) in GBP written in USD, the target's corporate currency, GBP not being " +
        "active there: amounts converted at the source's rates (Amount)",
    ]);
  });

  it('prints the prices left out for their own in the currency written, and linked to it', () => {
    const lines = outcomeLines({
      totalSuccess: 2,
      totalFailure: 0,
      totalSkipped: 0,
      totalLinked: 2,
      elapsedMs: 1,
      completedObjects: ['PricebookEntry'],
      failedObjects: [],
      skippedObjects: [],
      objectOutcomes: {
        PricebookEntry: {
          written: 2,
          linked: 2,
          failed: 0,
          refusals: [],
          pricesSettled: [{ from: 'GBP', to: 'USD', how: 'replaced', forLines: false, prices: 2 }],
        },
      },
    });

    expect(lines).toEqual([
      `  ${'PricebookEntry'.padEnd(28)} written 2  linked 2  refused 0`,
      '      2 GBP → USD: price(s) in a currency the target does not hold active replaced by the ' +
        "source's own price in the currency written, for the same product and price book",
    ]);
  });

  it('prints the statuses given back to records born a draft, and why the others were not', () => {
    const lines = outcomeLines({
      totalSuccess: 3,
      totalFailure: 0,
      totalSkipped: 0,
      elapsedMs: 1,
      completedObjects: ['Order'],
      failedObjects: [],
      skippedObjects: [],
      objectOutcomes: { Order: { written: 3, linked: 0, failed: 0, refusals: [] } },
      statuses: {
        Order: {
          applied: 2,
          refusals: [
            {
              statusCode: 'FIELD_INTEGRITY_EXCEPTION',
              fields: [],
              count: 1,
              message: 'Commande sans produit',
            },
          ],
        },
      },
    });

    expect(lines.slice(1)).toEqual([
      `  ${'Order'.padEnd(28)} statuses applied 2  refused 1`,
      '      FIELD_INTEGRITY_EXCEPTION x1: Commande sans produit',
    ]);
  });

  it("prints the lookups left to the target's default, and those filled after the wave", () => {
    const lines = outcomeLines({
      totalSuccess: 12,
      totalFailure: 0,
      totalSkipped: 0,
      elapsedMs: 1,
      completedObjects: ['Order', 'Account'],
      failedObjects: [],
      skippedObjects: [],
      objectOutcomes: {
        Order: {
          written: 11,
          linked: 0,
          failed: 0,
          refusals: [],
          leftToDefault: [{ field: 'OwnerId', count: 11 }],
        },
      },
      lookups: {
        Account: {
          filled: 15,
          refusals: [
            {
              statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
              fields: ['KeyContact__c'],
              count: 1,
              message: 'Le contact doit appartenir au compte',
            },
          ],
        },
      },
    });

    expect(lines).toEqual([
      `  ${'Order'.padEnd(28)} written 11  linked 0  refused 0`,
      "      left to the target's default: OwnerId x11",
      `  ${'Account'.padEnd(28)} lookups filled 15  refused 1`,
      '      FIELD_CUSTOM_VALIDATION_EXCEPTION [KeyContact__c] x1: Le contact doit appartenir au compte',
    ]);
  });

  it('prints the records left out because the platform writes them, or what they hang from, itself', () => {
    const tracked = { field: 'Type', value: 'TrackedChange', noun: 'tracked change' };
    const lines = outcomeLines({
      totalSuccess: 3,
      totalFailure: 0,
      totalSkipped: 0,
      elapsedMs: 1,
      completedObjects: ['FeedItem', 'FeedComment'],
      failedObjects: [],
      skippedObjects: [],
      objectOutcomes: {
        FeedItem: {
          written: 2,
          linked: 0,
          failed: 0,
          refusals: [],
          leftToThePlatform: [{ objectApiName: 'FeedItem', why: { rows: tracked }, count: 3 }],
        },
        FeedComment: {
          written: 1,
          linked: 0,
          failed: 0,
          refusals: [],
          leftToThePlatform: [
            {
              objectApiName: 'FeedComment',
              why: { rows: tracked, through: 'FeedItemId' },
              count: 1,
            },
          ],
        },
      },
    });

    expect(lines).toEqual([
      `  ${'FeedItem'.padEnd(28)} written 2  linked 0  refused 0`,
      '      3 tracked changes left out: the platform writes them itself',
      `  ${'FeedComment'.padEnd(28)} written 1  linked 0  refused 0`,
      '      1 left out: FeedItemId names a tracked change, which the platform writes itself',
    ]);
  });

  it('prints the contacts of person accounts left to the platform, linked to and not sent', () => {
    const lines = outcomeLines({
      totalSuccess: 20,
      totalFailure: 0,
      totalSkipped: 0,
      elapsedMs: 1,
      completedObjects: ['Contact'],
      failedObjects: [],
      skippedObjects: [],
      objectOutcomes: {
        Contact: { written: 20, linked: 10, failed: 0, refusals: [], withTheirPersonAccount: 10 },
      },
    });

    expect(lines).toEqual([
      `  ${'Contact'.padEnd(28)} written 20  linked 10  refused 0`,
      '      10 contact(s) of person accounts left to the platform, which wrote each with its ' +
        'account: linked to it, not sent',
    ]);
  });

  it('prints a node that died before writing with the error it died with', () => {
    const lines = outcomeLines({
      totalSuccess: 0,
      totalFailure: 0,
      totalSkipped: 0,
      elapsedMs: 1,
      completedObjects: [],
      failedObjects: ['Account'],
      skippedObjects: [],
      nodeErrors: { Account: 'INVALID_SESSION_ID: Session expired or invalid' },
      objectOutcomes: {},
    });

    expect(lines).toEqual([
      `  ${'Account'.padEnd(28)} FAILED: INVALID_SESSION_ID: Session expired or invalid`,
    ]);
  });
});

describe('sandforge-autopilot — the plan', () => {
  it('says the currencies the target does not hold active, the one their records go in and the objects whose amounts are converted', () => {
    const lines = scopeLines({
      maxDepth: 5,
      maxObjects: 50,
      selected: ['Opportunity'],
      parents: [],
      leftEmpty: [],
      standardNeeded: [],
      currencies: { notInTarget: ['GBP'], writtenIn: 'USD', objects: ['Account', 'Opportunity'] },
    });

    expect(lines).toContain(
      '  currencies the target does not hold active: GBP — a record in one is written in USD, ' +
        "its corporate currency, its amounts converted at the source's rates (Account, Opportunity)",
    );
  });

  it('says a selected table larger than one read takes is copied from its first records by Id, of how many', () => {
    // Said in the log alone, the plan showed 50 000 beside a count of millions.
    const lines = scopeLines({
      maxDepth: 5,
      maxObjects: 50,
      selected: ['Account', 'Case'],
      parents: [],
      leftEmpty: [],
      standardNeeded: [],
      cutShort: [
        { objectApiName: 'Account', copied: 50_000, total: 2_000_000 },
        { objectApiName: 'Case', copied: 50_000 },
      ],
    });

    expect(lines).toContain(
      '  Account: 50000 of 2000000 record(s) copied, the first by Id -- a run copies no more of ' +
        'a selected object',
    );
    expect(lines).toContain(
      '  Case: 50000 record(s) copied, the first by Id -- a run copies no more of a selected object',
    );
  });

  it('lists a selected table cut to its first records by Id on its cut line alone, never among those copied whole', () => {
    // Step 4 leaves a cut table out of the tables copied whole; the command
    // line listed it there as well as on its cut line.
    const lines = scopeLines({
      maxDepth: 5,
      maxObjects: 50,
      selected: ['Account', 'Contact'],
      parents: [],
      leftEmpty: [],
      standardNeeded: [],
      cutShort: [{ objectApiName: 'Account', copied: 50_000, total: 2_000_000 }],
    });

    expect(lines).toContain('  copied whole, as selected: Contact');
    expect(lines.filter((line) => line.includes('Account'))).toEqual([
      '  Account: 50000 of 2000000 record(s) copied, the first by Id -- a run copies no more of ' +
        'a selected object',
    ]);

    const allCut = scopeLines({
      maxDepth: 5,
      maxObjects: 50,
      selected: ['Account'],
      parents: [],
      leftEmpty: [],
      standardNeeded: [],
      cutShort: [{ objectApiName: 'Account', copied: 50_000, total: 2_000_000 }],
    });
    expect(allCut.some((line) => line.includes('copied whole'))).toBe(false);
  });

  it('says which standard parents were followed by default, and through which lookups', () => {
    // Left out with standard objects off, the account of every opportunity
    // stayed empty; it is followed now, and the plan says so.
    const lines = scopeLines({
      maxDepth: 5,
      maxObjects: 50,
      selected: ['Opportunity', 'Contact'],
      parents: [{ objectApiName: 'Account', records: 20 }],
      leftEmpty: [],
      standardNeeded: [],
      followedByDefault: [
        { objectApiName: 'Account', referencedBy: ['Opportunity.AccountId', 'Contact.AccountId'] },
      ],
    });

    expect(lines).toContain(
      '  Account followed by default though standard objects are off: ' +
        'Opportunity.AccountId, Contact.AccountId reference it',
    );
  });

  it('says how the write gate sized the person accounts it counted', () => {
    expect(
      personAccountLines(
        new Map([
          ['Account', 10],
          ['Contact', 10],
        ]),
      ),
    ).toEqual([
      '  sized as Salesforce counts them: 10 person account(s) at 4 KB each, ' +
        '10 contact(s) of person accounts at none of their own',
    ]);
    expect(personAccountLines(new Map())).toEqual([]);
  });
});

describe('contactPointLines', () => {
  it('says how many emails and phone numbers the run neutralized, and where, or that it kept them', () => {
    expect(
      contactPointLines({
        contactPoints: {
          neutralized: true,
          fields: [
            { objectApiName: 'Contact', field: 'Email', kind: 'email', values: 3 },
            { objectApiName: 'Contact', field: 'Phone', kind: 'phone', values: 2 },
          ],
          values: 5,
        },
      }),
    ).toEqual([
      'emails and phone numbers: 5 neutralized (Contact.Email 3, Contact.Phone 2) -- addresses ' +
        'under .invalid, numbers fictional',
    ]);
    expect(
      contactPointLines({ contactPoints: { neutralized: true, fields: [], values: 0 } }),
    ).toEqual(['emails and phone numbers: none to neutralize']);
    expect(contactPointLines({})).toEqual([
      'emails and phone numbers: written as read (--keep-contact-points)',
    ]);
  });
});
