import { describe, expect, it, vi } from 'vitest';
import type { ForgeTargetAutomation, ForgeTargetFlow } from '@sandforge/shared';
import { mutePlanOf } from '@sandforge/shared';
import { EMAILS_NOT_ACCEPTED } from '../forge/ForgeRunGate.js';
import { FROZEN_EMAILS_EXCEEDED, loadEmailsLines, loadEmailsOf } from './loadEmails.js';

/**
 * A load's gate on the emails, against a target whose contact flow sends two
 * single emails a contact, as the trap Developer Edition's does, and whose
 * bypass `Load_Data` the set `Data_Load` holds.
 */

/** A contact flow that sends `emails` single emails, quiet for `Load_Data` when `bypass`. */
function contactFlow(emails: number, bypass: boolean): ForgeTargetFlow {
  return {
    apiName: 'Contact_Welcome',
    label: 'Contact welcome',
    timing: 'afterSave',
    startsOn: 'create',
    condition: 'read',
    permissions: bypass ? [{ name: 'Load_Data', bypass: true }] : [],
    messages: Array.from({ length: emails }, (_, n) => ({
      kind: 'email' as const,
      name: `Send ${n + 1}`,
      limit: 'SingleEmail' as const,
    })),
  };
}

function automation(flows: ForgeTargetFlow[]): ForgeTargetAutomation {
  return {
    objectsRead: ['Contact'],
    objects: [{ objectApiName: 'Contact', flows, triggers: [] }],
    bypassGrants: [
      {
        permission: 'Load_Data',
        permissionSets: [{ name: 'Data_Load', label: 'Data load', grants: 1 }],
      },
    ],
    unread: [],
  } as unknown as ForgeTargetAutomation;
}

const INSERTS = (_object: string, write: string): boolean =>
  write === 'insert' || write === 'update';

function gate(
  read: ForgeTargetAutomation | { unread: string },
  options: {
    level?: 'all' | 'withheld';
    accepted?: boolean;
    contacts?: number;
    remaining?: number;
    mute?: boolean;
  } = {},
) {
  const readLimits = vi.fn(async () => ({
    SingleEmail: { max: 15, remaining: options.remaining ?? 15 },
  }));
  const readDeliverability = vi.fn(async () => ({
    reading: { level: options.level ?? 'all' } as const,
    requests: 1,
  }));
  const plan = options.mute === true && 'objects' in read ? mutePlanOf(read, INSERTS) : undefined;
  return {
    readLimits,
    readDeliverability,
    judged: loadEmailsOf({
      read,
      ...(plan ? { plan } : {}),
      writes: INSERTS,
      inserts: [{ objectApiName: 'Contact', rows: options.contacts ?? 3 }],
      readLimits,
      readDeliverability,
      accepted: options.accepted === true,
      target: 'DEV',
      mayMute: options.mute !== true,
    }),
  };
}

describe('loadEmailsOf', () => {
  it('reads nothing and asks nothing when nothing that still runs sends', async () => {
    const { judged, readLimits, readDeliverability } = gate(automation([]));
    const emails = await judged;

    expect(emails.stop).toBeUndefined();
    expect(emails.info).toEqual({ counted: [], verdict: 'nothingSends', accepted: false });
    expect(readLimits).not.toHaveBeenCalled();
    expect(readDeliverability).not.toHaveBeenCalled();
  });

  it('refuses a load into an org that delivers them, unaccepted, and names what lifts it', async () => {
    // A load inserted the contacts, the flow emailing each, with no question.
    const emails = await gate(automation([contactFlow(2, true)])).judged;

    expect(emails.stop?.code).toBe(EMAILS_NOT_ACCEPTED);
    expect(emails.stop?.message).toContain(
      'DEV delivers every email its automation sends (Setup > Deliverability: All email), and ' +
        'what still runs as this load writes its records sends some: flow "Contact welcome" on Contact.',
    );
    expect(emails.stop?.message).toContain('Add --accept-emails to load all the same');
    expect(emails.stop?.message).toContain('--mute-automation keeps quiet flow "Contact welcome"');
    expect(emails.info.verdict).toBe('asks');
    expect(emails.info.refused?.code).toBe(EMAILS_NOT_ACCEPTED);
  });

  it('lets it through with the accord, the emails counted against what the org has left', async () => {
    const emails = await gate(automation([contactFlow(2, false)]), { accepted: true }).judged;

    expect(emails.stop).toBeUndefined();
    expect(emails.info).toMatchObject({
      verdict: 'asks',
      accepted: true,
      counted: [{ limit: 'SingleEmail', emails: 6, verdict: 'fits', remaining: 15, max: 15 }],
    });
  });

  it('asks nothing of an org that delivers none of them, and still counts them', async () => {
    const emails = await gate(automation([contactFlow(2, false)]), { level: 'withheld' }).judged;

    expect(emails.stop).toBeUndefined();
    expect(emails.info.verdict).toBe('withheld');
    expect(emails.info.counted[0]?.emails).toBe(6);
  });

  it('refuses past what the org has left today, accorded or not: no accord lifts it', async () => {
    // Fifteen single emails a day, and 36 contacts at two each.
    const emails = await gate(automation([contactFlow(2, false)]), {
      accepted: true,
      contacts: 36,
    }).judged;

    expect(emails.stop?.code).toBe(FROZEN_EMAILS_EXCEEDED);
    expect(emails.stop?.message).toContain('about 72 single emails, 15 of 15 left today');
    expect(emails.stop?.message).toMatch(/Nothing was written\.$/);
  });

  it('asks of what it could not read, the org read for its deliverability', async () => {
    const { judged, readDeliverability } = gate({ unread: 'INSUFFICIENT_ACCESS' });
    const emails = await judged;

    expect(readDeliverability).toHaveBeenCalledTimes(1);
    expect(emails.info.uncounted).toBe("the target's automation: INSUFFICIENT_ACCESS");
    expect(emails.stop?.code).toBe(EMAILS_NOT_ACCEPTED);
  });

  it('judges what the mute leaves running: a flow it keeps quiet sends nothing', async () => {
    const emails = await gate(automation([contactFlow(2, true)]), { mute: true }).judged;

    expect(emails.stop).toBeUndefined();
    expect(emails.info.verdict).toBe('nothingSends');
  });
});

describe('loadEmailsLines', () => {
  it('says the count and what was read of the org, as the other command lines say them', async () => {
    const emails = await gate(automation([contactFlow(2, false)]), { accepted: true }).judged;

    expect(loadEmailsLines(emails.info, 'DEV')).toEqual([
      '  emails: these records make DEV send about 6 single emails (2 per Contact, by ' +
        'Contact welcome); it has 15 of 15 left today',
      '  deliverability: All email — the emails of what still runs go out (read with one line ' +
        'of anonymous Apex that sends nothing)',
    ]);
  });
});
