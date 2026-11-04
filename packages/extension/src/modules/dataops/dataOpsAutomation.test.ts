import { describe, expect, it, vi } from 'vitest';
import type { ForgeTargetAutomation, ForgeTargetFlow } from '@sandforge/shared';

import {
  AUTOMATION_NOT_ACCEPTED,
  EMAILS_EXCEEDED,
  dataOpsAutomationLines,
  dataOpsAutomationRefusal,
  dataOpsSaid,
  dataOpsStepsOf,
  dataOpsStop,
  dataOpsWrittenOf,
  readDataOpsAct,
  type DataOpsAutomationOrg,
} from './dataOpsAutomation.js';
import type { MuteOrg } from '../forge/AutomationMuteLease.js';
import { deliverabilityAfterLeaseStop } from '../forge/ForgeRunGate.js';

/** A record-triggered flow, after the save, that sends `emails` single emails. */
function flow(
  label: string,
  startsOn: ForgeTargetFlow['startsOn'],
  options: { emails?: number; bypass?: string; held?: boolean } = {},
): ForgeTargetFlow {
  return {
    apiName: label.replaceAll(' ', '_'),
    label,
    timing: 'afterSave',
    startsOn,
    condition: 'read',
    permissions: options.bypass
      ? [{ name: options.bypass, bypass: true, ...(options.held ? { held: true } : {}) }]
      : [],
    messages: Array.from({ length: options.emails ?? 0 }, (_, at) => ({
      kind: 'email' as const,
      name: `Send ${at}`,
      limit: 'SingleEmail' as const,
    })),
  };
}

/** The org's automation: per object, its flows and the events of its one trigger. */
function automationOf(
  objects: Record<string, { flows?: ForgeTargetFlow[]; trigger?: string[] }>,
): ForgeTargetAutomation {
  return {
    objectsRead: Object.keys(objects),
    objects: Object.entries(objects).map(([objectApiName, o]) => ({
      objectApiName,
      flows: o.flows ?? [],
      triggers: o.trigger ? [{ name: `${objectApiName}Trigger`, events: o.trigger as never }] : [],
    })),
    unread: [],
    conditionsNotRead: 0,
    conditionsBound: 0,
    requests: 1,
  };
}

/** An org whose reads answer as given; its deliverability All email unless told. */
function orgOf(
  automation: ForgeTargetAutomation | Error,
  options: {
    deliverability?: 'all' | 'withheld';
    single?: { max: number; remaining: number };
  } = {},
): DataOpsAutomationOrg & { reads: string[][]; deliverabilityReads: () => number } {
  const reads: string[][] = [];
  let deliverabilityReads = 0;
  return {
    reads,
    deliverabilityReads: () => deliverabilityReads,
    readAutomation: async (objects) => {
      reads.push([...objects]);
      if (automation instanceof Error) throw automation;
      return automation;
    },
    readLimits: async () => ({
      SingleEmail: options.single ?? { max: 5_000, remaining: 5_000 },
      DailyWorkflowEmails: { max: 1_000_000, remaining: 1_000_000 },
    }),
    readDeliverability: async () => {
      deliverabilityReads++;
      return { reading: { level: options.deliverability ?? 'all' }, requests: 1 };
    },
    muteOrg: async () => {
      throw new Error('the mute was not asked for');
    },
  };
}

describe('the steps and the records a DataOps act writes', () => {
  it('reads a masking as an update, a restore as an undelete then an update, a cleanup as a delete', () => {
    expect(dataOpsStepsOf('masking', ['Contact'])).toEqual({ giveBack: ['Contact'] });
    expect(dataOpsStepsOf('restore', ['Contact'])).toEqual({
      bringBack: ['Contact'],
      giveBack: ['Contact'],
    });
    expect(dataOpsStepsOf('cleanup', ['Case'])).toEqual({ delete: ['Case'] });
  });

  it('counts the emails on every record a masking updates and a cleanup deletes, none of an object it does not write', () => {
    expect(
      dataOpsWrittenOf('masking', [
        { objectApiName: 'Contact', records: 40 },
        { objectApiName: 'Lead', records: 0 },
      ]),
    ).toEqual([{ objectApiName: 'Contact', write: 'update', records: 40 }]);
    expect(dataOpsWrittenOf('cleanup', [{ objectApiName: 'Case', records: 3 }])).toEqual([
      { objectApiName: 'Case', write: 'delete', records: 3 },
    ]);
  });
});

describe('what the command line says of what fires', () => {
  it('names each flow and trigger a masking fires as it updates, and nothing of what starts on create', () => {
    const automation = automationOf({
      Contact: {
        flows: [flow('Welcome Email', 'create'), flow('Notify Owner', 'update', { emails: 1 })],
        trigger: ['beforeUpdate'],
      },
    });
    const lines = dataOpsAutomationLines(
      automation,
      'TGT',
      'masking',
      dataOpsStepsOf('masking', ['Contact']),
    );
    expect(lines).toEqual([
      'masking automation: what TGT runs as the masking writes over the records',
      '  Contact: as it is masked, before save: Apex trigger ContactTrigger',
      '  Contact: as it is masked, after save: flow "Notify Owner"',
    ]);
  });

  it('says what a cleanup fires before and after each delete, and that nothing fires when nothing does', () => {
    const fires = automationOf({ Case: { flows: [flow('Guard Delete', 'delete')] } });
    expect(
      dataOpsAutomationLines(fires, 'TGT', 'cleanup', dataOpsStepsOf('cleanup', ['Case'])),
    ).toContain('  Case: after delete: flow "Guard Delete"');
    expect(
      dataOpsAutomationLines(
        automationOf({ Case: {} }),
        'TGT',
        'cleanup',
        dataOpsStepsOf('cleanup', ['Case']),
      ),
    ).toEqual([
      'cleanup automation: what TGT runs as the cleanup deletes the records',
      '  nothing fires on the 1 object(s) it deletes records of',
    ]);
  });

  it('names the after-undelete trigger a restore fires as it brings records back from the recycle bin', () => {
    const lines = dataOpsAutomationLines(
      automationOf({ Contact: { trigger: ['afterUndelete'] } }),
      'TGT',
      'restore',
      dataOpsStepsOf('restore', ['Contact']),
    );
    expect(lines).toContain(
      '  Contact: as it comes back from the recycle bin: Apex trigger ContactTrigger',
    );
  });
});

describe('the refusal of what fires, not accepted', () => {
  it('names what fires, the set that keeps it quiet, the mute that assigns it, and the flag that lifts it', () => {
    const automation = {
      ...automationOf({
        Contact: { flows: [flow('Notify Owner', 'update', { bypass: 'Skip_Flows' })] },
      }),
      bypassGrants: [
        {
          permission: 'Skip_Flows',
          permissionSets: [{ name: 'Flow_Bypass', label: 'Flow Bypass', grants: 1 }],
        },
      ],
    };
    const refusal = dataOpsAutomationRefusal(automation, 'TGT', {
      act: 'masking',
      steps: dataOpsStepsOf('masking', ['Contact']),
      assign: [{ permission: 'Skip_Flows', permissionSet: 'Flow_Bypass', others: [] }],
      mayMute: true,
    });
    expect(refusal).toContain(
      'TGT runs automation as this masking writes over its records: Contact: flow "Notify Owner"',
    );
    expect(refusal).toContain('With --mute-automation, the masking assigns Flow_Bypass');
    expect(refusal).toMatch(
      /Nothing was written\. Add --accept-automation to mask all the same, or turn that automation off in TGT first\.$/,
    );
  });

  it('refuses on what could not be read as on what fires, and says nothing when nothing fires', () => {
    expect(
      dataOpsAutomationRefusal({ unread: 'INVALID_SESSION_ID' }, 'TGT', {
        act: 'cleanup',
        steps: dataOpsStepsOf('cleanup', ['Case']),
      }),
    ).toContain(
      'could not be read (INVALID_SESSION_ID), so what fires is not known. Nothing was deleted.',
    );
    expect(
      dataOpsAutomationRefusal(automationOf({ Case: {} }), 'TGT', {
        act: 'cleanup',
        steps: dataOpsStepsOf('cleanup', ['Case']),
      }),
    ).toBeUndefined();
  });
});

describe('readDataOpsAct', () => {
  const contacts = [{ objectApiName: 'Contact', records: 40 }];

  it('refuses a masking whose update flow fires without --accept-automation, and its emails without --accept-emails', async () => {
    const org = orgOf(
      automationOf({ Contact: { flows: [flow('Notify Owner', 'update', { emails: 1 })] } }),
    );
    const read = await readDataOpsAct({
      act: 'masking',
      target: 'TGT',
      objects: contacts,
      org,
      accord: {},
      mayMute: true,
    });
    expect(org.reads).toEqual([['Contact']]);
    expect(read.answer.refusals.map((r) => r.code)).toEqual([
      AUTOMATION_NOT_ACCEPTED,
      'EMAILS_NOT_ACCEPTED',
    ]);
    expect(read.answer.emailsAsk).toBe(true);
    expect(read.answer.emails).toEqual([
      expect.objectContaining({ limit: 'SingleEmail', emails: 40, verdict: 'fits' }),
    ]);
    expect(read.answer.lines).toContain(
      '  emails: about 40 single emails (1 per Contact), 5000 of 5000 left today',
    );
    expect(dataOpsStop(read.answer)?.code).toBe(AUTOMATION_NOT_ACCEPTED);
    expect(dataOpsStop(read.answer)?.message).toContain('Add --accept-emails to mask all the same');
  });

  it('lets a masking through once both are accepted, and asks nothing of an org that delivers none', async () => {
    const automation = automationOf({
      Contact: { flows: [flow('Notify Owner', 'update', { emails: 1 })] },
    });
    const accepted = await readDataOpsAct({
      act: 'masking',
      target: 'TGT',
      objects: contacts,
      org: orgOf(automation),
      accord: { acceptAutomation: true, acceptEmails: true },
      mayMute: true,
    });
    expect(accepted.answer.refusals).toEqual([]);
    const withheld = await readDataOpsAct({
      act: 'masking',
      target: 'TGT',
      objects: contacts,
      org: orgOf(automation, { deliverability: 'withheld' }),
      accord: { acceptAutomation: true },
      mayMute: true,
    });
    expect(withheld.answer.refusals).toEqual([]);
    expect(withheld.answer.emailsAsk).toBe(false);
  });

  it('refuses past the emails the org has left today, whatever is accepted', async () => {
    const read = await readDataOpsAct({
      act: 'masking',
      target: 'TGT',
      objects: contacts,
      org: orgOf(
        automationOf({ Contact: { flows: [flow('Notify Owner', 'update', { emails: 1 })] } }),
        { single: { max: 15, remaining: 15 } },
      ),
      accord: { acceptAutomation: true, acceptEmails: true },
      mayMute: true,
    });
    expect(read.answer.refusals.map((r) => r.code)).toEqual([EMAILS_EXCEEDED]);
    expect(read.answer.refusals[0]?.message).toContain(
      'This masking would make TGT send about 40 single emails (1 per Contact), 15 of 15 left today',
    );
  });

  it('reads nothing and refuses nothing when no object holds a record to write', async () => {
    const org = orgOf(automationOf({ Contact: { flows: [flow('Notify Owner', 'update')] } }));
    const read = await readDataOpsAct({
      act: 'masking',
      target: 'TGT',
      objects: [{ objectApiName: 'Contact', records: 0 }],
      org,
      accord: {},
      mayMute: true,
    });
    expect(org.reads).toEqual([]);
    expect(org.deliverabilityReads()).toBe(0);
    expect(read.answer.refusals).toEqual([]);
  });

  it('refuses a cleanup whose automation could not be read, and reads the deliverability for what may send', async () => {
    const org = orgOf(new Error('INSUFFICIENT_ACCESS'));
    const read = await readDataOpsAct({
      act: 'cleanup',
      target: 'TGT',
      objects: [{ objectApiName: 'Case', records: 2 }],
      org,
      accord: {},
      mayMute: false,
    });
    expect(read.answer.automationUnread).toBe('INSUFFICIENT_ACCESS');
    expect(read.answer.refusals.map((r) => r.code)).toEqual([
      AUTOMATION_NOT_ACCEPTED,
      'EMAILS_NOT_ACCEPTED',
    ]);
    expect(org.deliverabilityReads()).toBe(1);
  });

  it('plans the mute asked for, and refuses it on a production org before anything is assigned', async () => {
    const created = vi.fn();
    const muteOrg: MuteOrg = {
      typeOrg: async () => ({
        id: '00Dxx0000000001AAA',
        sandbox: false,
        edition: 'Enterprise Edition',
      }),
      query: async () => ({ records: [] }),
      identity: async () => ({
        user_id: '005xx0000000001AAA',
        organization_id: '00Dxx0000000001AAA',
      }),
      createAssignment: async (record) => {
        created(record);
        return { success: true, id: '0Paxx0000000001AAA' };
      },
      deleteAssignment: async () => ({ success: true }),
    };
    const read = await readDataOpsAct({
      act: 'masking',
      target: 'TGT',
      objects: contacts,
      org: {
        ...orgOf(
          automationOf({
            Contact: { flows: [flow('Notify Owner', 'update', { bypass: 'Skip_Flows' })] },
          }),
        ),
        muteOrg: async () => muteOrg,
      },
      accord: { muteAutomation: true, acceptAutomation: true },
      mayMute: true,
    });
    expect(read.answer.refusals[0]?.code).toBe('MUTE_PRODUCTION');
    expect(read.mute).toBeUndefined();
    expect(created).not.toHaveBeenCalled();
  });
});

describe('whose words a refusal is said in', () => {
  const contacts = [{ objectApiName: 'Contact', records: 40 }];
  const sending = {
    ...automationOf({
      Contact: { flows: [flow('Notify Owner', 'update', { emails: 1, bypass: 'Skip_Flows' })] },
    }),
    bypassGrants: [
      {
        permission: 'Skip_Flows',
        permissionSets: [{ name: 'Flow_Bypass', label: 'Flow Bypass', grants: 1 }],
      },
    ],
  };

  it("names a pipeline step's settings where the command line names its flags, every refusal of it", async () => {
    const read = await readDataOpsAct({
      act: 'masking',
      target: 'TGT',
      objects: contacts,
      org: orgOf(sending),
      accord: {},
      mayMute: true,
      voice: 'step',
    });
    const said = read.answer.refusals.map((r) => r.message).join(' ');
    expect(read.answer.refusals.map((r) => r.code)).toEqual([
      AUTOMATION_NOT_ACCEPTED,
      'EMAILS_NOT_ACCEPTED',
    ]);
    expect(said).toContain('Turn on acceptAutomation in the step to mask all the same');
    expect(said).toContain('Turn on acceptEmails in the step to mask all the same');
    expect(said).toContain('With muteAutomation in the step, the masking assigns Flow_Bypass');
    expect(said).toContain('muteAutomation in the step keeps quiet flow "Notify Owner" on Contact');
    expect(said).not.toMatch(/--[a-z]/);
  });

  it('calls an erasure an erasure, whether it writes over records as a masking or deletes them as a cleanup', () => {
    expect(
      dataOpsSaid(
        'This cleanup would make TGT send about 3 single emails, or delete fewer records. ' +
          'Nothing was deleted.',
        'erasure',
      ),
    ).toBe(
      'This erasure would make TGT send about 3 single emails, or erase fewer records. ' +
        'Nothing was deleted.',
    );
    expect(
      dataOpsSaid('TGT runs automation as this masking writes over its records.', 'erasure'),
    ).toBe('TGT runs automation as this erasure writes over its records.');
  });

  it("names the boxes of an erasure's confirmation where the command line names its flags, every refusal of it", async () => {
    const read = await readDataOpsAct({
      act: 'masking',
      target: 'TGT',
      objects: contacts,
      org: orgOf(sending),
      accord: {},
      mayMute: true,
      voice: 'erasure',
    });
    const said = read.answer.refusals.map((r) => r.message).join(' ');
    expect(read.answer.refusals.map((r) => r.code)).toEqual([
      AUTOMATION_NOT_ACCEPTED,
      'EMAILS_NOT_ACCEPTED',
    ]);
    // A subject erasure is the page's alone: its confirmation lists what
    // fires, and has a box for the mute and one for the emails.
    expect(said).toContain(
      "With the confirmation's box that mutes the target's automation ticked, the erasure " +
        'assigns Flow_Bypass',
    );
    expect(said).toContain(
      'Nothing was written. Confirm the erasure from its confirmation, which lists what fires, ' +
        'to erase all the same, or turn that automation off in TGT first.',
    );
    expect(said).toContain(
      "Nothing was written. Tick the confirmation's box that lets the org send these emails to " +
        'erase all the same',
    );
    expect(said).toContain(
      "The confirmation's box that mutes the target's automation keeps quiet flow " +
        '"Notify Owner" on Contact',
    );
    expect(said).not.toMatch(/--[a-z]/);
  });

  it("says an erasure past the day's emails, or one whose lease left a sender running, in the words of its confirmation", async () => {
    const read = await readDataOpsAct({
      act: 'masking',
      target: 'TGT',
      objects: contacts,
      org: orgOf(sending, { single: { max: 15, remaining: 15 } }),
      accord: { acceptAutomation: true, acceptEmails: true },
      mayMute: true,
      voice: 'erasure',
    });
    expect(read.answer.refusals.map((r) => r.code)).toEqual([EMAILS_EXCEEDED]);
    expect(read.answer.refusals[0]?.message).toContain(
      "(the confirmation's box that mutes the target's automation assigns one a permission set " +
        'holds), or erase fewer records.',
    );
    expect(read.answer.refusals[0]?.message).not.toMatch(/--[a-z]/);

    const relit = deliverabilityAfterLeaseStop({
      planned: [],
      held: [{ objectApiName: 'Contact', kind: 'flow', name: 'Notify Owner', why: 'email' }],
      reading: { level: 'all' },
      accepted: false,
      target: 'TGT',
      run: 'masking',
    });
    expect(dataOpsSaid(relit?.message ?? '', 'erasure')).toMatch(
      /Nothing was written\. Tick the confirmation's box that lets the org send these emails to erase all the same, or run it again once the lease can assign them\.$/,
    );
  });

  it("leaves the command line's own words as they are", () => {
    const words = 'Nothing was written. Add --accept-automation to mask all the same.';
    expect(dataOpsSaid(words)).toBe(words);
    expect(dataOpsSaid(words, 'flags')).toBe(words);
  });
});
