import { describe, expect, it } from 'vitest';
import type { EnvAuditResult } from '@sandforge/shared';
import {
  NOT_TOUCHED_HEADING,
  STILL_TO_DO_HEADING,
  code,
  handoffTitleOf,
  notTouchedLines,
  orgLineOf,
  secondOf,
  stillToDoLines,
  type StillToDoReaders,
} from './handoffSections.js';

/*
 * The sections of a handoff note that hold whatever handed the sandbox back:
 * its title and its org, what is left to do in a refresh checklist's order,
 * and what SandForge leaves to others. The command line's note and the
 * panel's are made of them.
 */

const ORG_ID = '00Dxx0000002AbCEAU';
const BEFORE = '00Dxx0000001gPLEAY';

/** What the reader that did not audit says reads it: a line, or a page. */
const READERS: StillToDoReaders = {
  endpoints: 'the Endpoints step lists those that still name production.',
  schedules: 'the Scheduled jobs step compares them with their inventory.',
};

/** The audits of a sandbox the morning after its refresh. */
const AUDITS: Pick<EnvAuditResult, 'deliverability' | 'schedules' | 'endpoints'> = {
  deliverability: { read: 'open' },
  schedules: {
    now: 4,
    kept: 2,
    against: { savedAt: '2026-11-18T20:00:00.000Z', organizationId: BEFORE, refreshed: true },
    jobs: [
      { name: 'Nightly ERP sync', type: 'Scheduled Apex', status: 'gone' },
      {
        name: 'Weekly digest',
        type: 'Scheduled Apex',
        status: 'frozen',
        owner: 'ops.batch@acme.com.uat',
      },
      { name: 'Data cleanup', type: 'Batch Job', status: 'new' },
    ],
  },
  endpoints: {
    productionHosts: ['erp.acme.com'],
    found: [
      {
        source: 'namedCredential',
        name: 'ERP_API',
        url: 'https://erp.acme.com/api',
        host: 'erp.acme.com',
        why: 'listed',
      },
    ],
  },
};

describe('the title and the org of a note', () => {
  it('names what was handed back and the org, by its alias or else its Id', () => {
    expect(
      handoffTitleOf('uat-testers', { organizationId: ORG_ID, kind: 'sandbox', alias: 'uat' }),
    ).toBe('# Handoff: `uat-testers` on `uat`');
    expect(handoffTitleOf('uat-testers', { organizationId: ORG_ID, kind: 'sandbox' })).toBe(
      `# Handoff: \`uat-testers\` on \`${ORG_ID}\``,
    );
  });

  it('names a sandbox by its My Domain, and any org by its kind and Id', () => {
    expect(
      orgLineOf({
        organizationId: ORG_ID,
        kind: 'sandbox',
        alias: 'uat',
        host: 'acme--uat.sandbox.my.salesforce.com',
      }),
    ).toBe(`- Org: \`uat\`, sandbox \`acme--uat\`, \`${ORG_ID}\`.`);
    expect(orgLineOf({ organizationId: ORG_ID, kind: 'sandbox' })).toBe(
      `- Org: sandbox, \`${ORG_ID}\`.`,
    );
    expect(orgLineOf({ organizationId: ORG_ID, kind: 'scratch', alias: 'qa' })).toBe(
      `- Org: \`qa\`, scratch org, \`${ORG_ID}\`.`,
    );
    expect(orgLineOf({ organizationId: ORG_ID, kind: 'developer' })).toBe(
      `- Org: Developer Edition org, \`${ORG_ID}\`.`,
    );
  });

  it('keeps a name from breaking its line or its code span, and an instant to the second', () => {
    expect(code('a`b\nc')).toBe('`a b c`');
    expect(secondOf('2026-11-20T08:14:49.123Z')).toBe('2026-11-20T08:14:49Z');
  });
});

describe('what is left to do', () => {
  it('follows a refresh checklist’s order: credentials, jobs, emails, deliverability', () => {
    const lines = stillToDoLines(AUDITS, READERS);
    expect(lines[0]).toBe(STILL_TO_DO_HEADING);
    const steps = lines.filter((line) => /^\d\. /.test(line)).map((line) => line.slice(0, 2));
    expect(steps).toEqual(['1.', '2.', '3.', '4.']);
  });

  it('names an endpoint by its host, a job gone, a job stuck and an open deliverability', () => {
    const lines = stillToDoLines(AUDITS, READERS);
    expect(lines).toContain(
      '   - Named Credential `ERP_API` names `erp.acme.com`, a production host the file lists.',
    );
    expect(lines).toContain(
      '   - `Nightly ERP sync` (Scheduled Apex) was scheduled in the inventory of 2026-11-18, and is not now.',
    );
    expect(lines).toContain(
      '   - `Weekly digest` (Scheduled Apex) runs as `ops.batch@acme.com.uat`, who is frozen: its next run fails.',
    );
    expect(lines.some((line) => line.includes('Data cleanup'))).toBe(false);
    expect(lines.at(-1)).toMatch(/^ {3}- Read open, All email: /);
    expect(lines.join('\n')).not.toContain('https://');
  });

  it('says what was not audited in the words of whoever reads it', () => {
    const lines = stillToDoLines(undefined, READERS);
    expect(lines).toContain(`   - Not audited: ${READERS.endpoints}`);
    expect(lines).toContain(`   - Not audited: ${READERS.schedules}`);
    expect(lines).toContain('   - Not read: Setup > Deliverability shows it.');
  });

  it('never says no job is gone without an inventory from before the refresh', () => {
    const lines = stillToDoLines(
      {
        schedules: {
          now: 1,
          kept: 0,
          jobs: [{ name: 'Data cleanup', type: 'Batch Job', status: 'new' }],
        },
      },
      READERS,
    );
    expect(lines).toContain(
      '   - No inventory from before the refresh was kept on this machine: what is gone is not known.',
    );
    expect(lines).toContain('   - None stuck.');
    expect(lines).not.toContain('   - None gone, none stuck.');
  });
});

describe('what SandForge does not touch', () => {
  it('says whose each thing it leaves is, passwords their owners’', () => {
    const lines = notTouchedLines();
    expect(lines[0]).toBe(NOT_TOUCHED_HEADING);
    expect(lines).toContain(
      "- Passwords: each user's own, by Forgot your password? on the sandbox's login page.",
    );
    for (const line of lines.filter((one) => one.startsWith('- '))) {
      expect(line).toMatch(/: (Setup|your deployment|each user's own)/);
    }
  });
});
