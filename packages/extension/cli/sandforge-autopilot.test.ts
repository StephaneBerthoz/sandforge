import { describe, it, expect, vi } from 'vitest';
import type { Connection } from 'jsforce';
import type { ApiName, AutopilotEdge, ExecutionPlan } from '@sandforge/shared';
import { AutopilotExecutor } from '../src/modules/autopilot/AutopilotExecutor.js';
import { RecordIdRemapper } from '../src/modules/autopilot/RecordIdRemapper.js';
import { SmartAnonymizer } from '../src/modules/autopilot/SmartAnonymizer.js';
import {
  contactPointLines,
  everyPage,
  outcomeLines,
  personAccountLines,
  scopeLines,
} from './sandforge-autopilot';
import { apiRequestsLine } from './sandforge-clone';

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
          leftDraft: 1,
        },
      },
    });

    expect(lines.slice(1)).toEqual([
      `  ${'Order'.padEnd(28)} statuses applied 2  refused 1`,
      '      FIELD_INTEGRITY_EXCEPTION x1: Commande sans produit',
    ]);
  });

  it('counts the records the target refused a status or a lookup, once each, whatever reasons it gave', () => {
    // Summed by reason, one order refused for two read "refused 2".
    const two = [
      { statusCode: 'FIELD_INTEGRITY_EXCEPTION', fields: ['Status'], count: 1, message: 'a' },
      { statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', fields: [], count: 1, message: 'b' },
    ];
    const lines = outcomeLines({
      totalSuccess: 2,
      totalFailure: 0,
      totalSkipped: 0,
      elapsedMs: 1,
      completedObjects: ['Order', 'Account'],
      failedObjects: [],
      skippedObjects: [],
      lookups: { Account: { filled: 0, refusals: two, leftEmpty: 1 } },
      statuses: { Order: { applied: 0, refusals: two, leftDraft: 1 } },
    });

    expect(lines).toContain(`  ${'Account'.padEnd(28)} lookups filled 0  refused 1`);
    expect(lines).toContain(`  ${'Order'.padEnd(28)} statuses applied 0  refused 1`);
  });

  it('says the records a stop left with a lookup empty or as drafts', () => {
    // Ctrl-C after a wave: the panel and the audit said them, the summary
    // named neither.
    const lines = outcomeLines({
      totalSuccess: 8,
      totalFailure: 0,
      totalSkipped: 0,
      elapsedMs: 1,
      completedObjects: ['Order'],
      failedObjects: [],
      skippedObjects: [],
      stopped: true,
      stoppedObjects: ['OrderItem'],
      objectOutcomes: {
        Order: {
          written: 8,
          linked: 0,
          failed: 0,
          refusals: [],
          lookupsLeftEmpty: 3,
          statusesNotGivenBack: 5,
        },
      },
    });

    expect(lines).toEqual([
      `  ${'Order'.padEnd(28)} written 8  linked 0  refused 0`,
      '      3 record(s) keep a lookup empty: the stop came before the second pass filled it',
      '      5 record(s) stay drafts: the stop came before their status was given back',
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
          leftEmpty: 1,
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

  it('prints what a stop kept an object from sending, as the audit counts it, and nothing of the kind for one written whole', () => {
    // Stopped as the contacts went in: one written, one never sent, and the
    // leads never reached. Their lines read as objects written whole.
    const lines = outcomeLines({
      totalSuccess: 2,
      totalFailure: 0,
      totalSkipped: 0,
      elapsedMs: 1,
      completedObjects: ['Account'],
      failedObjects: [],
      skippedObjects: [],
      stopped: true,
      stoppedObjects: ['Contact', 'Lead'],
      objectOutcomes: {
        Account: { written: 1, linked: 0, failed: 0, refusals: [] },
        Contact: { written: 1, linked: 0, failed: 0, refusals: [], notSent: 1 },
        Lead: { written: 0, linked: 0, failed: 0, refusals: [], notSent: 2 },
      },
    });

    expect(lines).toEqual([
      `  ${'Account'.padEnd(28)} written 1  linked 0  refused 0`,
      `  ${'Contact'.padEnd(28)} written 1  linked 0  refused 0  not sent 1`,
      `  ${'Lead'.padEnd(28)} written 0  linked 0  refused 0  not sent 2`,
    ]);
  });

  it('says the records a run held back under a parent whose write failed, with the object and why', async () => {
    // Run whole: the summary prints what the executor counted, the line of
    // the opportunity never written held back rather than refused by the
    // target for its empty lookup.
    const rows: Record<string, Record<string, unknown>[]> = {
      Opportunity: [
        { Id: 'oppA', Name: 'Deal A' },
        { Id: 'oppB', Name: 'Deal B' },
      ],
      OpportunityLineItem: [
        { Id: 'lineA', OpportunityId: 'oppA' },
        { Id: 'lineB', OpportunityId: 'oppB' },
      ],
    };
    const executor = new AutopilotExecutor({
      query: async (objectApiName, afterId) => {
        if (objectApiName === 'Opportunity' && afterId !== undefined) {
          throw new Error('QUERY_TIMEOUT: Your query request was running for too long.');
        }
        const list = rows[objectApiName] ?? [];
        const start = afterId === undefined ? 0 : list.findIndex((r) => r['Id'] === afterId) + 1;
        return list.slice(start, start + 1).map((row) => ({ ...row }));
      },
      insert: async (objectApiName, records) =>
        records.map((_, i) => ({
          id: `${objectApiName.slice(0, 3)}T${i}`,
          success: true,
          errors: [],
        })),
      anonymizer: new SmartAnonymizer(),
      remapper: new RecordIdRemapper(),
      batchSize: 1,
    });
    const plan: ExecutionPlan = {
      waves: [
        { order: 0, objects: ['Opportunity' as ApiName], dependsOn: [] },
        { order: 1, objects: ['OpportunityLineItem' as ApiName], dependsOn: [0] },
      ],
      totalRecords: 4,
      estimatedDurationSec: 1,
      estimatedApiCalls: 4,
      complianceFramework: 'none',
      anonymizationSummary: {
        totalPiiFields: 0,
        totalFieldsToAnonymize: 0,
        methodBreakdown: {
          fake: 0,
          mask: 0,
          hash: 0,
          nullify: 0,
          redact: 0,
          shuffle: 0,
          truncate: 0,
          preserve_format: 0,
          age_band: 0,
          generalize: 0,
          constant: 0,
        },
        objectsWithPii: [],
      },
      cycleResolutions: [],
    };
    const lineEdge: AutopilotEdge = {
      from: 'Opportunity' as ApiName,
      to: 'OpportunityLineItem' as ApiName,
      fieldApiName: 'OpportunityId',
      relationshipType: 'master_detail',
      required: true,
    };

    const result = await executor.execute(
      plan,
      [lineEdge],
      [],
      new Map([
        ['Opportunity', 2],
        ['OpportunityLineItem', 2],
      ]),
      undefined,
      new Map(),
      { keepContactPoints: true },
    );

    // The deal written before the read threw is counted on its line, the
    // error under it: the line said FAILED and nothing of the deal written.
    expect(outcomeLines(result)).toEqual([
      `  ${'Opportunity'.padEnd(28)} written 1  linked 0  refused 0`,
      '      FAILED part way: QUERY_TIMEOUT: Your query request was running for too long.',
      `  ${'OpportunityLineItem'.padEnd(28)} written 1  linked 0  refused 1`,
      '      PARENT_NOT_WRITTEN [OpportunityId] x1: the Opportunity record its OpportunityId ' +
        "names was not written: the run's write of Opportunity failed, and written without it " +
        'this record would stand without its Opportunity.',
    ]);
  });

  it('says the records a run held back for a record type the user may not use, per type, beside what it wrote', async () => {
    // Held back whole, the object's line said refused 3 of 3, its one reason
    // counting 1, and nothing written.
    const HIDDEN = '012TGT00000HidEAAA';
    const PARTNER = '012TGT00000PrtnAAA';
    const rows: Record<string, Record<string, unknown>[]> = {
      Opportunity: [
        { Id: 'oppA', Name: 'Open', RecordTypeId: null },
        { Id: 'oppB', Name: 'Hidden', RecordTypeId: HIDDEN },
        { Id: 'oppC', Name: 'Partner', RecordTypeId: PARTNER },
      ],
    };
    const closed = (recordTypeId: string, developerName: string) => ({
      recordTypeId,
      developerName,
      name: developerName,
      available: false,
      active: true,
      master: false,
      defaultRecordTypeMapping: false,
    });
    const executor = new AutopilotExecutor({
      query: async (objectApiName, afterId) =>
        afterId === undefined ? (rows[objectApiName] ?? []).map((row) => ({ ...row })) : [],
      insert: async (objectApiName, records) =>
        records.map((_, i) => ({
          id: `${objectApiName.slice(0, 3)}T${i}`,
          success: true,
          errors: [],
        })),
      describeRecordTypes: async () => [
        closed(HIDDEN, 'Hidden_Deal'),
        closed(PARTNER, 'Partner_Deal'),
      ],
      countRecordTypes: async () =>
        new Map([
          [HIDDEN, 1],
          [PARTNER, 1],
        ]),
      anonymizer: new SmartAnonymizer(),
      remapper: new RecordIdRemapper(),
      batchSize: 200,
    });
    const plan: ExecutionPlan = {
      waves: [{ order: 0, objects: ['Opportunity' as ApiName], dependsOn: [] }],
      totalRecords: 3,
      estimatedDurationSec: 1,
      estimatedApiCalls: 2,
      complianceFramework: 'none',
      anonymizationSummary: {
        totalPiiFields: 0,
        totalFieldsToAnonymize: 0,
        methodBreakdown: {
          fake: 0,
          mask: 0,
          hash: 0,
          nullify: 0,
          redact: 0,
          shuffle: 0,
          truncate: 0,
          preserve_format: 0,
          age_band: 0,
          generalize: 0,
          constant: 0,
        },
        objectsWithPii: [],
      },
      cycleResolutions: [],
    };

    const result = await executor.execute(
      plan,
      [],
      [],
      new Map([['Opportunity', 3]]),
      undefined,
      new Map(),
      { keepContactPoints: true },
    );

    expect(outcomeLines(result)).toEqual([
      `  ${'Opportunity'.padEnd(28)} written 1  linked 0  refused 2`,
      '      RECORD_TYPE_UNAVAILABLE [RecordTypeId] x1: 1 Opportunity record uses record type ' +
        'Hidden_Deal, which the running user cannot use in the target org. Give the running ' +
        'user access to record type Hidden_Deal on Opportunity, or map it to one they have.',
      '      RECORD_TYPE_UNAVAILABLE [RecordTypeId] x1: 1 Opportunity record uses record type ' +
        'Partner_Deal, which the running user cannot use in the target org. Give the running ' +
        'user access to record type Partner_Deal on Opportunity, or map it to one they have.',
      // The one on Master went in without a type, and the target, whose
      // other types are closed to the user, keeps it on Master.
      'record types the target gave the records created without one (1 object(s)):',
      '  Opportunity  1 record(s) on Master in the source: went in, its describe says, on ' +
        'Master, which the target gives a record sent without one for the user the run writes as',
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

  it('says the daily API requests the run takes against what the target has left, or why it cannot', () => {
    expect(
      apiRequestsLine({ verdict: 'exceeds', estimate: 3, max: 15_000, remaining: 1 }, 'TGT'),
    ).toBe(
      '  API requests: about 3, of the 1 TGT has left of its 15000 a day: more than it has left',
    );
    expect(
      apiRequestsLine({ verdict: 'near', estimate: 3, max: 15_000, remaining: 1_000 }, 'TGT'),
    ).toBe(
      '  API requests: about 3, of the 1000 TGT has left of its 15000 a day: it would leave less than a tenth of them',
    );
    expect(
      apiRequestsLine({ verdict: 'fits', estimate: 3, max: 15_000, remaining: 14_000 }, 'TGT'),
    ).toBe('  API requests: about 3, of the 14000 TGT has left of its 15000 a day');
    expect(apiRequestsLine({ verdict: 'unread', estimate: 3, unread: 'refused' }, 'TGT')).toBe(
      '  API requests: about 3; what TGT has left today could not be read (refused)',
    );
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
