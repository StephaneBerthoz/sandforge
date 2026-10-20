import { describe, expect, it } from 'vitest';
import type { SeedAutomationPreview } from '../types/seed.types.js';
import { seedEmailEstimates, seedEmailsRefused } from './seed-automation.js';

/** What a Developer Edition with a contact flow and a contact workflow rule answered. */
const preview: Pick<SeedAutomationPreview, 'emailsPerRecord' | 'limits' | 'limitsUnread'> = {
  emailsPerRecord: [
    {
      objectApiName: 'Contact',
      limit: 'SingleEmail',
      perRecord: 3,
      sentBy: ['Welcome Email', 'Contact Welcome'],
    },
    { objectApiName: 'Case', limit: 'SingleEmail', perRecord: 1, sentBy: ['Case Notice'] },
    {
      objectApiName: 'Contact',
      limit: 'DailyWorkflowEmails',
      perRecord: 1,
      sentBy: ['Contact Welcome'],
    },
  ],
  limits: {
    SingleEmail: { max: 15, remaining: 15 },
    DailyWorkflowEmails: { max: 8040, remaining: 8040 },
  },
};

describe('seedEmailEstimates', () => {
  it('counts the emails of each object by its records, against what the org has left of each limit', () => {
    expect(seedEmailEstimates(preview, { Account: 25, Contact: 75, Case: 50 })).toEqual([
      {
        limit: 'SingleEmail',
        emails: 275,
        objects: [
          {
            objectApiName: 'Contact',
            records: 75,
            perRecord: 3,
            sentBy: ['Welcome Email', 'Contact Welcome'],
          },
          { objectApiName: 'Case', records: 50, perRecord: 1, sentBy: ['Case Notice'] },
        ],
        verdict: 'exceeds',
        remaining: 15,
        max: 15,
      },
      {
        limit: 'DailyWorkflowEmails',
        emails: 75,
        objects: [
          { objectApiName: 'Contact', records: 75, perRecord: 1, sentBy: ['Contact Welcome'] },
        ],
        verdict: 'fits',
        remaining: 8040,
        max: 8040,
      },
    ]);
  });

  it('fits once the counts are lowered to what is left, and leaves out an object set to 0', () => {
    const estimates = seedEmailEstimates(preview, { Contact: 5, Case: 0 });
    expect(estimates.map((e) => [e.limit, e.emails, e.verdict])).toEqual([
      ['SingleEmail', 15, 'fits'],
      ['DailyWorkflowEmails', 5, 'fits'],
    ]);
    expect(estimates[0].objects.map((o) => o.objectApiName)).toEqual(['Contact']);
    expect(seedEmailsRefused(estimates)).toBe(false);
  });

  it('says nothing of a seed none of whose records sends', () => {
    expect(seedEmailEstimates(preview, { Account: 25 })).toEqual([]);
  });

  it('cannot say whether the emails fit when the org did not say what it has left', () => {
    const estimates = seedEmailEstimates(
      { ...preview, limits: undefined, limitsUnread: 'INSUFFICIENT_ACCESS' },
      { Contact: 75 },
    );
    expect(estimates.map((e) => e.verdict)).toEqual(['unread', 'unread']);
    expect(estimates[0]).not.toHaveProperty('remaining');
    expect(seedEmailsRefused(estimates)).toBe(false);
  });

  it('cannot say it of a limit the org does not list', () => {
    const estimates = seedEmailEstimates(
      { ...preview, limits: { DailyWorkflowEmails: { max: 8040, remaining: 8040 } } },
      { Contact: 75 },
    );
    expect(estimates.map((e) => [e.limit, e.verdict])).toEqual([
      ['SingleEmail', 'unread'],
      ['DailyWorkflowEmails', 'fits'],
    ]);
  });
});

describe('seedEmailsRefused', () => {
  it('refuses a seed one of whose limits it would take past what is left', () => {
    expect(seedEmailsRefused(seedEmailEstimates(preview, { Contact: 6 }))).toBe(true);
    expect(seedEmailsRefused(seedEmailEstimates(preview, { Contact: 5 }))).toBe(false);
  });
});
