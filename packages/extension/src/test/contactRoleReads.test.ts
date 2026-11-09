import { describe, it, expect } from 'vitest';
import {
  MADE_BY_THE_RUN,
  RUN_USER,
  WENT_IN,
  answerContactRoles,
  secondsAfterItWentIn,
} from './contactRoleReads.js';
import { contactRolesSoql, madeWithItsOpportunity } from '../core/common/platformRecords.js';

const DEAL = '006TGT000000001AAA';
const OTHER_DEAL = '006TGT000000002AAA';
const BUYER = '003TGT000000001AAA';

describe('answerContactRoles', () => {
  const opportunities: Record<string, Record<string, unknown>> = {
    [DEAL.slice(0, 15)]: { Id: DEAL, ...MADE_BY_THE_RUN },
  };
  const opportunityOf = (id: string) => opportunities[id.slice(0, 15)];
  const platforms = {
    Id: '00KTGT000000001AAA',
    OpportunityId: DEAL,
    ContactId: BUYER,
    ...MADE_BY_THE_RUN,
  };
  const byHand = {
    Id: '00KTGT000000002AAA',
    OpportunityId: DEAL,
    ContactId: BUYER,
    CreatedDate: secondsAfterItWentIn(4),
    CreatedById: RUN_USER,
  };
  const elsewhere = { Id: '00KTGT000000003AAA', OpportunityId: OTHER_DEAL, ContactId: BUYER };

  it('answers the roles under the opportunities read, in the order held, each with when and by whom its opportunity was made', () => {
    const answered = answerContactRoles(
      contactRolesSoql([DEAL.slice(0, 15)], ['Role']),
      [byHand, platforms, elsewhere],
      opportunityOf,
    );

    expect(answered).toEqual([
      { ...byHand, Opportunity: { CreatedDate: WENT_IN, CreatedById: RUN_USER } },
      { ...platforms, Opportunity: { CreatedDate: WENT_IN, CreatedById: RUN_USER } },
    ]);
    expect(answered?.map(madeWithItsOpportunity)).toEqual([false, true]);
  });

  it('answers null for the opportunity of a role the target holds no record of, and nothing to another statement', () => {
    expect(answerContactRoles(contactRolesSoql([OTHER_DEAL]), [elsewhere], opportunityOf)).toEqual([
      { ...elsewhere, Opportunity: null },
    ]);
    expect(answerContactRoles('SELECT Id FROM Opportunity', [platforms], opportunityOf)).toBe(
      undefined,
    );
  });

  it('dates seconds after the run wrote, as the org answers a date', () => {
    expect(secondsAfterItWentIn(4)).toBe('2026-11-09T11:47:04.000+0000');
  });
});
