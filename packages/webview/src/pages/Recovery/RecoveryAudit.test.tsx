import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import '../../i18n';
import { RecoveryAudit } from './RecoveryAudit';
import { auditOf } from './testing/recoveryFixtures';

const SETUP = { myDomainHost: 'example--uat.sandbox.my.salesforce.com' };

describe('RecoveryAudit', () => {
  it('says the deliverability as read, open or closed, and links its Setup page', () => {
    const { rerender } = render(
      <RecoveryAudit step="deliverability" audit={auditOf()} alias="UAT" setup={SETUP} />,
    );
    expect(screen.getByTestId('recovery-audit-deliverability')).toHaveTextContent(
      'UAT delivers every email (Setup > Deliverability: All email): what runs there reaches real people.',
    );
    expect(screen.getByRole('link', { name: 'Open Setup' })).toHaveAttribute(
      'href',
      'https://example--uat.sandbox.my.salesforce.com/lightning/setup/OrgEmailSettings/home',
    );

    rerender(
      <RecoveryAudit
        step="deliverability"
        audit={auditOf({ deliverability: { read: 'closed' } })}
        alias="UAT"
        setup={SETUP}
      />,
    );
    expect(screen.getByTestId('recovery-audit-deliverability')).toHaveTextContent(
      'UAT delivers system email at most',
    );
  });

  it('says a reading the org would not answer could not be read, never that it found nothing', () => {
    render(
      <RecoveryAudit
        step="deliverability"
        audit={auditOf({ deliverability: { unread: 'INSUFFICIENT_ACCESS' } })}
        alias="UAT"
        setup={SETUP}
      />,
    );
    const said = screen.getByTestId('recovery-audit-deliverability');
    expect(said).toHaveTextContent('Could not be read, which says nothing either way');
    expect(said).not.toHaveTextContent('INSUFFICIENT_ACCESS');
  });

  it('lists the jobs gone or stuck since the inventory of before, and those as before', () => {
    render(<RecoveryAudit step="scheduledJobs" audit={auditOf()} alias="UAT" setup={SETUP} />);
    const jobs = screen.getByTestId('recovery-audit-scheduledJobs');
    expect(jobs).toHaveTextContent(/^5 scheduled jobs now, compared with the inventory of /);
    expect(within(jobs).getByTestId('recovery-audit-job')).toHaveTextContent(
      'Nightly rollup (Scheduled Apex): gone since the inventory',
    );
    expect(jobs).toHaveTextContent('5 jobs as before.');
    expect(within(jobs).getByRole('link', { name: 'Open Setup' })).toHaveAttribute(
      'href',
      'https://example--uat.sandbox.my.salesforce.com/lightning/setup/ScheduledJobs/home',
    );
  });

  it('says the jobs have nothing to be compared with without an inventory, and the one kept now', () => {
    const audit = auditOf();
    render(
      <RecoveryAudit
        step="scheduledJobs"
        audit={{
          ...audit,
          schedules: { now: 1, jobs: [], kept: 0, saved: '/home/someone/.sandforge/audits/x.json' },
        }}
        alias="UAT"
        setup={SETUP}
      />,
    );
    const jobs = screen.getByTestId('recovery-audit-scheduledJobs');
    expect(jobs).toHaveTextContent(
      '1 scheduled job now, with no inventory of before to compare it with.',
    );
    expect(screen.getByTestId('recovery-audit-inventory-kept')).toHaveTextContent(
      'This inventory is kept for the next refresh.',
    );
  });

  it('lists each place that still names production with its Setup page', () => {
    render(<RecoveryAudit step="endpoints" audit={auditOf()} alias="UAT" setup={SETUP} />);
    const endpoints = screen.getByTestId('recovery-audit-endpoints');
    expect(endpoints).toHaveTextContent('1 place still names production:');
    const found = within(endpoints).getByTestId('recovery-audit-endpoint');
    expect(found).toHaveTextContent(
      "Named Credential ERP: example.my.salesforce.com (production's My Domain)",
    );
    expect(within(found).getByRole('link', { name: 'Open Setup: ERP' })).toHaveAttribute(
      'href',
      'https://example--uat.sandbox.my.salesforce.com/lightning/setup/NamedCredential/home',
    );
  });

  it('says nothing names production when nothing does, and why no host was deduced', () => {
    const audit = auditOf();
    render(
      <RecoveryAudit
        step="endpoints"
        audit={{
          ...audit,
          endpoints: {
            productionHosts: ['login.salesforce.com'],
            found: [],
            notDeduced: 'the host is not a sandbox host',
          },
        }}
        alias="UAT"
        setup={SETUP}
      />,
    );
    const endpoints = screen.getByTestId('recovery-audit-endpoints');
    expect(endpoints).toHaveTextContent('Nothing read in UAT names production.');
    expect(endpoints).toHaveTextContent(
      "Production's own hosts could not be deduced from the host of UAT",
    );
    expect(endpoints).not.toHaveTextContent('the host is not a sandbox host');
  });

  it('links no Setup page on a host SandForge does not open', () => {
    render(
      <RecoveryAudit
        step="deliverability"
        audit={auditOf()}
        alias="UAT"
        setup={{ instanceUrl: 'http://example.my.salesforce.com' }}
      />,
    );
    expect(screen.queryByRole('link')).toBeNull();
  });
});
