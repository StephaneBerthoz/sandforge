import { describe, it, expect, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import type { RewoundMark as RewoundMarkOf } from '@sandforge/shared';
import i18n from '../../i18n';
import fr from '../../i18n/locales/fr.json';
import { formatStoredDate } from '../../utils/formatters';
import { RewoundBadge, RewoundMark } from './RewoundMark';

const MARK: RewoundMarkOf = {
  kind: 'rewound',
  rewindId: 'rw-20261028-120000-aaaa',
  checkpointId: 'ck-20261028-100000-aaaa',
  checkpointName: 'Before UAT',
  at: '2026-10-28T12:10:00.000Z',
  leftSome: false,
  outside: [],
};

/** How the mark writes a date: this machine's zone, to the minute. */
const shown = (iso: string): string => formatStoredDate(iso, 'yyyy-MM-dd HH:mm') ?? '';

describe('RewoundMark', () => {
  afterEach(async () => {
    await act(async () => {
      await i18n.changeLanguage('en');
    });
  });

  it('says when a rewind took the run back, and to which checkpoint', () => {
    render(<RewoundMark mark={MARK} testId="mark" />);

    expect(screen.getByTestId('mark').textContent).toBe(
      `Rewound on ${shown(MARK.at)} to “Before UAT”`,
    );
  });

  it('says a run rewound in part, and a rewind stopped part way', () => {
    const { rerender } = render(<RewoundMark mark={{ ...MARK, kind: 'partly' }} testId="mark" />);
    expect(screen.getByTestId('mark').textContent).toMatch(
      /^Rewound in part on .* to “Before UAT”: /,
    );

    rerender(<RewoundMark mark={{ ...MARK, kind: 'stopped' }} testId="mark" />);
    expect(screen.getByTestId('mark').textContent).toBe(
      `A rewind to “Before UAT” stopped part way on ${shown(MARK.at)}`,
    );
  });

  it('adds what became of the run since: records left, an undo, objects the checkpoint did not hold', () => {
    render(
      <RewoundMark
        mark={{
          ...MARK,
          leftSome: true,
          undoneAt: '2026-10-28T13:00:00.000Z',
          outside: ['Opportunity', 'Case'],
        }}
        testId="mark"
      />,
    );

    expect(screen.getByTestId('mark').textContent).toBe(
      [
        `Rewound on ${shown(MARK.at)} to “Before UAT”`,
        'the rewind left some records: open the removal to see what is left',
        `undone on ${shown('2026-10-28T13:00:00.000Z')}`,
        'Not rewound: Opportunity, Case, outside the checkpoint',
      ].join(' · '),
    );
  });

  it('is written in the interface language', async () => {
    i18n.addResourceBundle('fr', 'translation', fr);
    await act(async () => {
      await i18n.changeLanguage('fr');
    });
    render(<RewoundMark mark={MARK} testId="mark" />);

    expect(screen.getByTestId('mark').textContent).toContain('retour arrière à « Before UAT »');
  });

  it('says it in a word where a line has no room', () => {
    render(<RewoundBadge mark={MARK} testId="badge" />);

    expect(screen.getByTestId('badge').textContent).toBe('Rewound');
  });
});
