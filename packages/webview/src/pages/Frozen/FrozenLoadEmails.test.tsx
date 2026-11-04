import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import type { FrozenLoadEmailsInfo } from '@sandforge/shared';
import { FrozenLoadEmails } from './FrozenLoadEmails';

/** What a load's gate found on an org whose contact flow sends two single emails a contact. */
function emails(over: Partial<FrozenLoadEmailsInfo> = {}): FrozenLoadEmailsInfo {
  return {
    counted: [
      {
        limit: 'SingleEmail',
        objects: [{ objectApiName: 'Contact', rows: 3, perRecord: 2, sentBy: ['Contact welcome'] }],
        emails: 6,
        verdict: 'fits',
        remaining: 15,
        max: 15,
      },
    ],
    verdict: 'asks',
    deliverability: {
      reading: { level: 'all' },
      senders: [{ objectApiName: 'Contact', kind: 'flow', name: 'Contact welcome', why: 'email' }],
    },
    accepted: false,
    refused: { code: 'EMAILS_NOT_ACCEPTED', message: 'DEV delivers every email…' },
    ...over,
  };
}

describe('FrozenLoadEmails', () => {
  it('says a load would be refused for emails the org delivers, what sends them and how many', () => {
    render(<FrozenLoadEmails emails={emails()} org="DEV" testId="e" />);

    expect(screen.getByTestId('e-verdict').textContent).toBe(
      'DEV delivers every email what still runs sends as the load writes, or would not say ' +
        'whether it does: the load would be refused, nothing written, unless you tick “Load ' +
        'even though DEV delivers the emails”.',
    );
    expect(screen.getByTestId('e-senders').textContent).toBe(
      'What sends them: Contact welcome (Contact).',
    );
    expect(screen.getByTestId('e-count-SingleEmail').textContent).toBe(
      'Single emails: about 6, with 15 of 15 left today.',
    );
  });

  it('says the load sends them once the box is ticked', () => {
    render(
      <FrozenLoadEmails
        emails={emails({ accepted: true, refused: undefined })}
        org="DEV"
        testId="e"
      />,
    );

    expect(screen.getByTestId('e-verdict').textContent).toContain(
      'with the box ticked, the load sends them',
    );
  });

  it('says an org that delivers none asks nothing, and still counts them', () => {
    render(
      <FrozenLoadEmails
        emails={emails({ verdict: 'withheld', refused: undefined })}
        org="DEV"
        testId="e"
      />,
    );

    expect(screen.getByTestId('e-verdict').textContent).toContain(
      'DEV delivers none of the emails its automation sends (System email only or No access)',
    );
  });

  it('says a load past what the org has left today would be refused whatever the box says', () => {
    const past = emails({
      accepted: true,
      counted: [
        {
          limit: 'SingleEmail',
          objects: [],
          emails: 72,
          verdict: 'exceeds',
          remaining: 15,
          max: 15,
        },
      ],
      refused: { code: 'FROZEN_EMAILS_EXCEEDED', message: 'The target’s automation…' },
    });
    render(<FrozenLoadEmails emails={past} org="DEV" testId="e" />);

    expect(screen.getByTestId('e-count-SingleEmail').textContent).toBe(
      'Single emails: about 72, more than the 15 of 15 left today.',
    );
    expect(screen.getByTestId('e-exceeded').textContent).toContain(
      'the load would be refused, nothing written, whatever the box says',
    );
  });

  it('says what could not be counted', () => {
    render(
      <FrozenLoadEmails
        emails={emails({ counted: [], uncounted: "the target's flows: INSUFFICIENT_ACCESS" })}
        org="DEV"
        testId="e"
      />,
    );

    expect(screen.getByTestId('e-uncounted').textContent).toBe(
      "Not all of them were counted: the target's flows: INSUFFICIENT_ACCESS could not be read.",
    );
  });
});
