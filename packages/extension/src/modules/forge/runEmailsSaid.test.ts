import { describe, expect, it } from 'vitest';

import { emailsRefusalWords, runEmailsDetailsOf, runEmailsSaidOf } from './runEmailsSaid.js';

describe('runEmailsSaidOf', () => {
  it('says nothing of a run that read nothing and has no accord', () => {
    expect(runEmailsSaidOf(undefined, false)).toEqual({});
    expect(runEmailsSaidOf({}, false)).toEqual({});
  });

  it('keeps the accord of a run nothing was read for: a lease may yet leave a sender running', () => {
    expect(runEmailsSaidOf(undefined, true)).toEqual({ emails: { accepted: true } });
  });

  it('keeps what the org said beside the accord', () => {
    expect(runEmailsSaidOf({ audit: 'all' }, true)).toEqual({
      emails: { accepted: true, deliverability: 'all' },
    });
  });
});

describe('runEmailsDetailsOf', () => {
  it('says the emails were accepted only where it mattered', () => {
    expect(runEmailsDetailsOf({ accepted: true, deliverability: 'all' })).toEqual({
      deliverability: 'all',
      confirmed: 'emails',
    });
    expect(runEmailsDetailsOf({ accepted: true, deliverability: 'unread' })).toEqual({
      deliverability: 'unread',
      confirmed: 'emails',
    });
    expect(runEmailsDetailsOf({ accepted: true, deliverability: 'withheld' })).toEqual({
      deliverability: 'withheld',
    });
    expect(runEmailsDetailsOf({ accepted: false, deliverability: 'all' })).toEqual({
      deliverability: 'all',
    });
  });

  it('says nothing when nothing was read', () => {
    expect(runEmailsDetailsOf(undefined)).toEqual({});
    expect(runEmailsDetailsOf({ accepted: true })).toEqual({});
  });
});

describe('emailsRefusalWords', () => {
  it('says what lifts a refusal where the run runs, and keeps the flag on the command line', () => {
    const message = 'Nothing was written. Add --accept-emails to sync all the same, set the org…';

    expect(emailsRefusalWords(message, 'sync', undefined)).toBe(message);
    expect(emailsRefusalWords(message, 'sync', 'Approve it to sync all the same')).toBe(
      'Nothing was written. Approve it to sync all the same, set the org…',
    );
    expect(
      emailsRefusalWords(
        'Add --accept-emails to run it all the same, or run it again',
        'autopilot',
        'Untick Mute automation to run it all the same',
      ),
    ).toBe('Untick Mute automation to run it all the same, or run it again');
  });
});
