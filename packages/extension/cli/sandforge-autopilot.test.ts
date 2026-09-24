import { describe, it, expect } from 'vitest';
import { outcomeLines } from './sandforge-autopilot';

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
