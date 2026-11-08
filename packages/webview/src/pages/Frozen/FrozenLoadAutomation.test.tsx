import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import type { FrozenLoadAutomationInfo } from '@sandforge/shared';
import { FrozenLoadAutomation } from './FrozenLoadAutomation';

/**
 * What a Frozen preview says of what the target runs as the load writes,
 * against the flow a scratch org ran: after save on an opportunity product's
 * creation, deleting the record that started it.
 */
const FIRING: FrozenLoadAutomationInfo = {
  firing: [
    {
      objectApiName: 'OpportunityLineItem',
      kind: 'flow',
      name: 'GC Gate OLI Delete',
      writes: ['insert'],
    },
    {
      objectApiName: 'Opportunity',
      kind: 'trigger',
      name: 'OppStamp',
      writes: ['insert', 'update'],
    },
  ],
  accepted: false,
  refused: { code: 'AUTOMATION_NOT_ACCEPTED', message: 'host words' },
};

describe('FrozenLoadAutomation', () => {
  it('names each automation with the writes it runs on, and that a load would be refused unless the box is ticked', () => {
    render(<FrozenLoadAutomation automation={FIRING} org="DEV" testId="auto" />);

    expect(screen.getByTestId('auto').firstElementChild?.textContent).toBe(
      'What DEV runs as the load inserts its records and updates them:',
    );
    expect(
      Array.from(screen.getByTestId('auto-firing').querySelectorAll('li')).map(
        (li) => li.textContent,
      ),
    ).toEqual([
      'OpportunityLineItem — Flow: GC Gate OLI Delete, as its records are inserted',
      'Opportunity — Apex trigger: OppStamp, as its records are inserted and updated',
    ]);
    expect(screen.getByTestId('auto-verdict').textContent).toBe(
      'A load would be refused, nothing written, unless you tick “Load although DEV runs automation as the records go in”, or mute it.',
    );
    // The page's words: no flag of the command line.
    expect(screen.getByTestId('auto').textContent).not.toContain('--');
  });

  it('says a load with the box ticked goes on, and what could not be read', () => {
    render(
      <FrozenLoadAutomation
        automation={{
          firing: [],
          unread: [{ part: 'automation', reason: 'INSUFFICIENT_ACCESS' }],
          accepted: true,
        }}
        org="DEV"
        testId="auto"
      />,
    );

    expect(screen.getByTestId('auto-unread-automation').textContent).toBe(
      'What DEV runs could not be read (INSUFFICIENT_ACCESS): the load asks as though something runs.',
    );
    expect(screen.getByTestId('auto-verdict').textContent).toBe(
      'With the box ticked, the load writes all the same, and this automation runs.',
    );
    expect(screen.queryByTestId('auto-firing')).toBeNull();
  });
});
