import { describe, expect, it } from 'vitest';
import {
  BUILTIN_PIPELINE_TEMPLATES,
  RECOVERY_MARKABLE_STEPS,
  RECOVERY_REASONS,
  RECOVERY_SKIPPABLE_STEPS,
  RECOVERY_STEP_IDS,
  usersConfigSchema,
  usernameKey as contractUsernameKey,
} from '@sandforge/shared';
import en from '../../i18n/locales/en.json';
import {
  MARKABLE_STEPS,
  SANDBOX_REFRESH_TEMPLATE_ID,
  SKIPPABLE_STEPS,
  choiceKeyOf,
  entryOfRead,
  lineKeyOf,
  lineOf,
  planVerdictOf,
  replayAsksName,
  setupPageOfEndpoint,
  setupUrlOf,
  userRowsOf,
  usernameKey,
  usersConfigOf,
  usersRefusalKeyOf,
  type LineWords,
} from './recoveryFacts';
import { auditOf, planOfAna, refreshedStatus, usersList } from './testing/recoveryFixtures';

/** The value at a dotted key of the English catalogue. */
function english(key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node !== null && typeof node === 'object'
          ? (node as Record<string, unknown>)[part]
          : undefined,
      en,
    );
}

const WORDS: LineWords = { alias: 'UAT', date: (iso) => `<${iso}>`, count: (n) => `#${n}` };

describe('the step lists the page keeps beside the contract', () => {
  it('skips and marks done the very steps the contract lets a person skip and mark', () => {
    expect([...SKIPPABLE_STEPS]).toEqual([...RECOVERY_SKIPPABLE_STEPS]);
    expect([...MARKABLE_STEPS]).toEqual([...RECOVERY_MARKABLE_STEPS]);
  });

  it('compares usernames as the contract does', () => {
    expect(usernameKey('Ana.Tester@Example.com')).toBe(
      contractUsernameKey('Ana.Tester@Example.com'),
    );
  });

  it('opens Automation on the template the marketplace ships for a sandbox refresh', () => {
    const template = BUILTIN_PIPELINE_TEMPLATES.find(
      (each) => each.id === SANDBOX_REFRESH_TEMPLATE_ID,
    );
    expect(template?.name).toBe('Sandbox Refresh Post-Processing');
  });
});

describe('the line of a step', () => {
  it('has a sentence in English for every step and every reason', () => {
    for (const step of RECOVERY_STEP_IDS) {
      for (const reason of RECOVERY_REASONS) {
        const key = lineKeyOf(step, reason);
        expect(typeof english(key), `${step}/${reason}: ${key}`).toBe('string');
      }
    }
  });

  it('has no sentence of a replay refused in Staging, where a replay is confirmed by its name', () => {
    expect(lineKeyOf('frozen', 'stagingSandbox')).toBe('recovery.line.frozen.stagingSandbox');
    expect(lineKeyOf('replay', 'stagingSandbox')).toBe('recovery.reason.stagingSandbox');
  });

  it('says what a replay opens, of the checkpoint taken before the refresh', () => {
    expect(lineOf('replay', 'toDo', refreshedStatus(), WORDS)).toEqual({
      key: 'recovery.line.replay.toDo',
      params: { alias: 'UAT', name: 'Before refresh', date: '<2026-11-10T09:00:00.000Z>' },
    });
  });

  it('says what a load writes, with the counts of the frozen dataset', () => {
    expect(lineOf('frozen', 'toDo', refreshedStatus(), WORDS).params).toEqual({
      alias: 'UAT',
      records: '#1250',
      objects: '#4',
      date: '<2026-11-01T10:00:00.000Z>',
    });
  });

  it('falls back on the reason’s sentence when the status lacks the fact a step’s names', () => {
    const status = refreshedStatus({ checkpointBefore: undefined });
    expect(lineOf('replay', 'toDo', status, WORDS)).toEqual({
      key: 'recovery.reason.toDo',
      params: { alias: 'UAT' },
    });
  });

  it('names the users run that ran after the refresh', () => {
    const status = refreshedStatus(
      { lastUsersRun: { run: 3, at: '2026-11-18T09:00:00.000Z', status: 'success' } },
      { users: { reason: 'ranAfterRefresh' } },
    );
    expect(lineOf('users', 'ranAfterRefresh', status, WORDS)).toEqual({
      key: 'recovery.line.users.ranAfterRefresh',
      params: { alias: 'UAT', run: '3' },
    });
  });

  it('says a replay into a sandbox marked Staging asks for the org’s name, while it is to do', () => {
    expect(replayAsksName(refreshedStatus({ tier: 'staging' }))).toBe(true);
    expect(replayAsksName(refreshedStatus())).toBe(false);
    expect(
      replayAsksName(refreshedStatus({ tier: 'staging' }, { replay: { reason: 'skipped' } })),
    ).toBe(false);
  });
});

describe('Setup', () => {
  it('opens a Setup page on the My Domain host, nothing of the stored address beside', () => {
    expect(
      setupUrlOf('deliverability', { myDomainHost: 'example--uat.sandbox.my.salesforce.com' }),
    ).toBe('https://example--uat.sandbox.my.salesforce.com/lightning/setup/OrgEmailSettings/home');
    expect(
      setupUrlOf('scheduledJobs', {
        instanceUrl: 'https://user:secret@example.my.salesforce.com/path?key=1',
      }),
    ).toBe('https://example.my.salesforce.com/lightning/setup/ScheduledJobs/home');
  });

  it('opens nothing on a host that is not HTTPS', () => {
    expect(setupUrlOf('remoteSite', { instanceUrl: 'http://example.my.salesforce.com' })).toBe(
      undefined,
    );
    expect(setupUrlOf('remoteSite', {})).toBe(undefined);
  });

  it('sends each endpoint to the Setup page it is changed on', () => {
    const [named] = auditOf().endpoints?.found ?? [];
    expect(named && setupPageOfEndpoint(named)).toBe('namedCredential');
    const field = (name: string) =>
      setupPageOfEndpoint({
        source: 'field',
        name,
        url: 'https://example.my.salesforce.com',
        host: 'example.my.salesforce.com',
        why: 'myDomain',
      });
    expect(field('Integration__mdt.Erp.Endpoint__c')).toBe('customMetadata');
    expect(field('Settings__c.Default.Endpoint__c')).toBe('customSettings');
  });
});

describe('the users', () => {
  it('gives a user read its address back, activates and unfreezes it, and nothing more', () => {
    const [ana, bo] = usersList().users;
    expect(ana && entryOfRead(ana)).toEqual({
      username: 'ana.tester@example.com.uat',
      email: 'restore',
    });
    expect(bo && entryOfRead(bo)).toEqual({
      username: 'bo.qa@example.com.uat',
      email: 'restore',
      active: true,
      frozen: false,
    });
  });

  it('builds the list a run is asked with, as sandforge users --config reads it', () => {
    const rows = userRowsOf(usersList().users);
    const config = usersConfigOf(rows, new Set(['bo.qa@example.com.uat']));
    expect(usersConfigSchema.parse(config)).toEqual({
      users: [{ username: 'bo.qa@example.com.uat', email: 'restore', active: true, frozen: false }],
    });
    expect(usersConfigOf(rows, new Set())).toBe(undefined);
  });

  it('keeps a users.json entry whole, its defaults too, and lists the users only it names', () => {
    const given = usersConfigSchema.parse({
      defaults: { permissionSets: ['QA_Tools'] },
      users: [
        { username: 'ANA.TESTER@example.com.uat', profile: 'QA Profile' },
        { username: 'cy.only@example.com.uat', active: true },
      ],
    });
    const rows = userRowsOf(usersList().users, given);
    expect(rows.map((row) => row.key)).toEqual([
      'ana.tester@example.com.uat',
      'bo.qa@example.com.uat',
      'cy.only@example.com.uat',
    ]);
    const config = usersConfigOf(
      rows,
      new Set(['ana.tester@example.com.uat', 'cy.only@example.com.uat']),
      given,
    );
    expect(config).toEqual({
      defaults: { permissionSets: ['QA_Tools'] },
      users: [
        { username: 'ANA.TESTER@example.com.uat', profile: 'QA Profile' },
        { username: 'cy.only@example.com.uat', active: true },
      ],
    });
  });

  it('tells two lists apart by what they ask', () => {
    const rows = userRowsOf(usersList().users);
    const one = usersConfigOf(rows, new Set(['ana.tester@example.com.uat']));
    const two = usersConfigOf(
      rows,
      new Set(['ana.tester@example.com.uat', 'bo.qa@example.com.uat']),
    );
    expect(choiceKeyOf(one)).not.toBe(choiceKeyOf(two));
    expect(choiceKeyOf(undefined)).toBe('');
  });

  it('reads of a simulation what it asks the person to accept apart from what refuses it', () => {
    const verdict = planVerdictOf(
      planOfAna({
        refusals: [
          { code: 'AUTOMATION_NOT_ACCEPTED', message: 'what fires' },
          { code: 'USERS_EMAILS_OPEN', message: 'all email' },
          { code: 'USERS_EMAILS_NOT_ACCEPTED', message: 'one person' },
          { code: 'USERS_SELF', message: 'locked out', username: 'admin@example.com.uat' },
        ],
      }),
    );
    expect(verdict.asked).toEqual(['acceptUserEmails', 'acceptEmails', 'acceptAutomation']);
    expect(verdict.blocking.map((refusal) => refusal.code)).toEqual(['USERS_SELF']);
    expect(verdict.changes).toBe(true);
  });

  it('says a simulation that changes nothing changes nothing', () => {
    const plan = planOfAna();
    const unchanged = planOfAna({
      users: plan.users.map((user) => ({ ...user, changes: [] })),
      refusals: [],
      emailsToPeople: 0,
    });
    expect(planVerdictOf(unchanged)).toEqual({ asked: [], blocking: [], changes: false });
  });

  it('words every refusal code it knows, and any other by its code', () => {
    expect(usersRefusalKeyOf('USERS_SELF')).toBe('recovery.users.refusal.USERS_SELF');
    expect(usersRefusalKeyOf('USERS_SOMETHING_NEW')).toBe('recovery.users.refusal.other');
    expect(typeof english(usersRefusalKeyOf('USERS_SOMETHING_NEW'))).toBe('string');
  });
});
