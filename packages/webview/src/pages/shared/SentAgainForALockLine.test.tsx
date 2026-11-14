import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import i18n from '../../i18n';
import fr from '../../i18n/locales/fr.json';
import { SentAgainForALockLine } from './SentAgainForALockLine';

describe('SentAgainForALockLine', () => {
  afterEach(async () => {
    await act(async () => {
      await i18n.changeLanguage('en');
    });
  });

  it('says the records sent again for a lock and how many the target then took', () => {
    render(
      <SentAgainForALockLine entry={{ rows: 37, written: 37, stillLocked: 0 }} testId="lock" />,
    );

    expect(screen.getByTestId('lock').textContent).toBe(
      '37 records the target org refused because it could not lock a record their write needed ' +
        '(UNABLE_TO_LOCK_ROW) went again on their own, up to 3 times, waiting longer each time: ' +
        '37 written.',
    );
  });

  it('says those the lock still held and those refused for another reason, which the refusals list', () => {
    render(
      <SentAgainForALockLine entry={{ rows: 12, written: 9, stillLocked: 2 }} testId="lock" />,
    );

    expect(screen.getByTestId('lock').textContent).toBe(
      '12 records the target org refused because it could not lock a record their write needed ' +
        '(UNABLE_TO_LOCK_ROW) went again on their own, up to 3 times, waiting longer each time: ' +
        '9 written. 2 still refused for the lock, among the refusals. 1 refused for another ' +
        'reason, among the refusals.',
    );
  });

  it('says one record in the singular', () => {
    render(<SentAgainForALockLine entry={{ rows: 1, written: 0, stillLocked: 1 }} testId="lock" />);

    expect(screen.getByTestId('lock').textContent).toBe(
      '1 record the target org refused because it could not lock a record its write needed ' +
        '(UNABLE_TO_LOCK_ROW) went again on its own, up to 3 times, waiting longer each time: ' +
        '0 written. 1 still refused for the lock, among the refusals.',
    );
  });

  it('says nothing when no record was sent again', () => {
    const { container } = render(
      <SentAgainForALockLine entry={{ rows: 0, written: 0, stillLocked: 0 }} testId="lock" />,
    );
    render(<SentAgainForALockLine entry={undefined} testId="none" />);

    expect(container.textContent).toBe('');
    expect(screen.queryByTestId('none')).toBeNull();
  });

  it("speaks the page's language", async () => {
    i18n.addResourceBundle('fr', 'translation', fr, true, true);
    await act(async () => {
      await i18n.changeLanguage('fr');
    });
    render(<SentAgainForALockLine entry={{ rows: 3, written: 3, stillLocked: 0 }} testId="lock" />);

    expect(screen.getByTestId('lock').textContent).toContain(
      "3 enregistrements que l'org cible a refusés",
    );
    expect(screen.getByTestId('lock').textContent).toContain('Écrits : 3.');
  });

  it('renders as a list item where the lines around it are one', () => {
    render(
      <ul>
        <SentAgainForALockLine
          as="li"
          entry={{ rows: 2, written: 2, stillLocked: 0 }}
          testId="lock"
        />
      </ul>,
    );

    expect(screen.getByTestId('lock').tagName).toBe('LI');
  });
});
