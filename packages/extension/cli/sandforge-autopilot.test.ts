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
