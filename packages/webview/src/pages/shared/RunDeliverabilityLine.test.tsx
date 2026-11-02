import { describe, it, expect, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import i18n from '../../i18n';
import fr from '../../i18n/locales/fr.json';
import type { EmailDeliverability, EmailSender } from '@sandforge/shared';
import { RunDeliverabilityLine } from './RunDeliverabilityLine';

const FLOW: EmailSender = {
  objectApiName: 'Contact',
  kind: 'flow',
  name: 'Welcome email',
  why: 'email',
};

function renderLine(
  reading: EmailDeliverability,
  senders: readonly EmailSender[] = [FLOW],
  unlisted = false,
): void {
  render(
    <RunDeliverabilityLine
      reading={reading}
      senders={senders}
      unlisted={unlisted}
      org="TGT-DEV"
      testId="line"
    />,
  );
}

describe('RunDeliverabilityLine', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('says on All email who sends, where it goes, and that the run reads the org again', () => {
    renderLine({ level: 'all' });

    expect(screen.getByTestId('line-reading').textContent).toBe(
      'TGT-DEV delivers every email its automation sends (Setup > Deliverability: All email), and what still runs as the run writes may send some: Flow “Welcome email” on Contact.',
    );
    expect(screen.getByTestId('line-addresses').textContent).toBe(
      "They go to the addresses the records and the alerts name, those of the records' owners and of the records already in TGT-DEV among them.",
    );
    expect(screen.getByTestId('line-read-again').textContent).toBe(
      'The run reads TGT-DEV again just before it writes, and asks first if they would go out.',
    );
  });

  it('says an org that would not say why, and what its two closed levels do', () => {
    renderLine({ unread: 'the org answered nothing' });

    const said = screen.getByTestId('line-reading').textContent;
    expect(said).toContain(
      'Whether TGT-DEV delivers the emails its automation sends could not be read (the org answered nothing)',
    );
    expect(said).toContain('Flow “Welcome email” on Contact');
    expect(said).toContain('On System email only or No access (Setup > Deliverability)');
    expect(screen.getByTestId('line-addresses')).toBeDefined();
  });

  it('says of an org that withholds them that nothing goes out, with no address to warn of, the read again still said', () => {
    renderLine({ level: 'withheld' });

    expect(screen.getByTestId('line-reading').textContent).toBe(
      'TGT-DEV delivers none of the emails its flows, processes, workflow rules and Apex send (Setup > Deliverability: System email only or No access), so nothing goes out of Flow “Welcome email” on Contact as the run writes.',
    );
    expect(screen.queryByTestId('line-addresses')).toBeNull();
    expect(screen.getByTestId('line-read-again')).toBeDefined();
  });

  it('names each kind of sender, why a sender only may send, and what could not be read', () => {
    renderLine(
      { level: 'all' },
      [
        { objectApiName: 'Case', kind: 'process', name: 'Notify', why: 'notRead' },
        { objectApiName: 'Case', kind: 'workflowRule', name: 'Alert', why: 'email' },
        { objectApiName: 'Lead', kind: 'assignmentRule', name: 'Route', why: 'assignment' },
      ],
      true,
    );

    expect(screen.getByTestId('line-reading').textContent).toContain(
      'Process “Notify” on Case (its definition was not read), Workflow rule “Alert” on Case, Assignment rule “Route” on Lead (applied: it can mail the owner it assigns) and what of its automation could not be read.',
    );
  });

  it('says what could not be read alone, where no sender is listed', () => {
    renderLine({ level: 'all' }, [], true);

    expect(screen.getByTestId('line-reading').textContent).toContain(
      'may send some: what of its automation could not be read.',
    );
  });

  it('names ten senders and counts the rest, in the page’s plural', () => {
    const many: EmailSender[] = Array.from({ length: 12 }, (_, at) => ({
      ...FLOW,
      name: `Flow ${at}`,
    }));
    renderLine({ level: 'all' }, many);

    const said = screen.getByTestId('line-reading').textContent ?? '';
    expect(said).toContain('Flow “Flow 9” on Contact');
    expect(said).not.toContain('Flow “Flow 10”');
    expect(said).toContain('and 2 more');
  });

  it('says it in the interface language', async () => {
    i18n.addResourceBundle('fr', 'translation', fr, true, true);
    await i18n.changeLanguage('fr');
    renderLine({ level: 'all' });

    expect(screen.getByTestId('line-reading').textContent).toContain(
      'TGT-DEV délivre tous les e-mails que ses automatisations envoient',
    );
    expect(screen.getByTestId('line-reading').textContent).toContain(
      'Flow « Welcome email » sur Contact',
    );
    expect(screen.getByTestId('line-read-again').textContent).toBe(
      "L'exécution relit TGT-DEV juste avant d'écrire, et demande d'abord s'ils partiraient.",
    );
  });
});
