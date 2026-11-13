import { describe, expect, it, vi } from 'vitest';
import type {
  CheckpointEmails,
  ForgeTargetAutomation,
  RewindDiff,
  RewindDiffObject,
  RewindSelectionPlan,
} from '@sandforge/shared';

import {
  REWIND_MUTING_STEP_WORDS,
  REWIND_STEP_WORDS,
  acceptanceRefusal,
  boundsRefusal,
  notConfirmedRefusal,
  previewTotals,
  selectionDiff,
  undeletableUnattendedRefusal,
  type BoundsCheck,
} from './rewindBounds.js';

/*
 * What a rewind nobody watches is held to, read from the preview it then acts
 * on: no org is reached here. That each bound refuses before the rewind
 * writes anything, and lets it write at its limit, is held on the memory org
 * through the handler (`CheckpointHandler.test.ts`) and the command line
 * (`sandforge-checkpoint.host.test.ts`).
 */

const SELF = '005000000000001AAA';
const AUTOMATED_PROCESS = '005000000000002AAA';
const COLLEAGUE = '005000000000003AAA';

function object(patch: Partial<RewindDiffObject> = {}): RewindDiffObject {
  return {
    objectApiName: 'Account',
    toDelete: { createdSince: 0, broughtBackSince: 0, comesBackWithParent: 0 },
    toGiveBack: { records: 0, fields: 0, clearedLookups: 0 },
    toBringBack: { inBin: 0, withParent: 0, deletedWhileTaken: 0 },
    cannotUndo: [],
    outside: [],
    touched: 0,
    unexplained: 0,
    lastChangedBy: {},
    notCompared: [],
    ...patch,
  };
}

function diffOf(objects: RewindDiffObject[], patch: Partial<RewindDiff> = {}): RewindDiff {
  return {
    checkpointId: 'ck-20261022-160000-cccc',
    previewId: 'pv-20261022-170000-eeee',
    readAt: '2026-10-22T17:00:00.000Z',
    objects,
    undoCannot: [],
    unread: [],
    access: { kind: 'org' },
    userNames: {},
    activeLastHour: [],
    ...patch,
  };
}

/**
 * A colleague's work since the checkpoint, four records: two cases created,
 * an account renamed, a contact deleted. The colleague is still at work.
 */
const FOUR = diffOf(
  [
    object({ toGiveBack: { records: 1, fields: 1, clearedLookups: 0 } }),
    object({
      objectApiName: 'Case',
      toDelete: { createdSince: 2, broughtBackSince: 0, comesBackWithParent: 0 },
    }),
    object({
      objectApiName: 'Contact',
      toBringBack: { inBin: 1, withParent: 0, deletedWhileTaken: 0 },
    }),
  ],
  { activeLastHour: [COLLEAGUE], userNames: { [COLLEAGUE]: 'A colleague' } },
);

/** What the org runs as a rewind writes: nothing, read whole. */
const NO_AUTOMATION: ForgeTargetAutomation = {
  objectsRead: ['Account', 'Case', 'Contact'],
  objects: [],
  unread: [],
  conditionsNotRead: 0,
  conditionsBound: 0,
  requests: 0,
};

const NOTHING_ACCEPTED = { acceptAutomation: false, acceptNoUndo: false, acceptRecreate: false };

/** A check of `diff` held to `bounds`, nothing accepted, the rewind writing as SELF. */
function check(
  diff: RewindDiff,
  bounds: BoundsCheck['bounds'],
  extra: Partial<BoundsCheck> = {},
): BoundsCheck {
  return {
    orgName: 'DEV-SB',
    preview: { diff, automation: NO_AUTOMATION },
    bounds,
    accepted: NOTHING_ACCEPTED,
    writers: () => Promise.resolve([SELF, AUTOMATED_PROCESS]),
    words: REWIND_STEP_WORDS,
    ...extra,
  };
}

describe('boundsRefusal — the records a rewind may rewind', () => {
  it('lets a rewind of as many records as its bound allows through, and refuses one more, with both numbers and what it would do', async () => {
    expect(
      await boundsRefusal(check(FOUR, { maxRecords: 4, refuseWhenActive: false })),
    ).toBeUndefined();

    expect(await boundsRefusal(check(FOUR, { maxRecords: 3, refuseWhenActive: false }))).toEqual({
      code: 'TOO_MANY_TO_REWIND',
      message:
        'The rewind of DEV-SB would rewind 4 records (2 to delete, 1 to give back, 1 to bring ' +
        "back), past this step's limit of 3. Rewind refused; preview the rewind, then raise the " +
        "step's maxRecords to what it rewinds and confirm it again. No record was written.",
    });
  });

  it('counts the records it makes again with new Ids among them, and has no bound without one', async () => {
    const remade = diffOf([
      object({ objectApiName: 'Contact', toRecreate: 2 }),
      object({ toGiveBack: { records: 1, fields: 1, clearedLookups: 0 } }),
    ]);
    const accepted = { ...NOTHING_ACCEPTED, acceptRecreate: true };

    const refused = await boundsRefusal(
      check(remade, { maxRecords: 2, refuseWhenActive: false }, { accepted }),
    );

    expect(refused?.code).toBe('TOO_MANY_TO_REWIND');
    expect(refused?.message).toContain(
      '3 records (0 to delete, 1 to give back, 0 to bring back, 2 to make again)',
    );
    expect(
      await boundsRefusal(check(remade, { refuseWhenActive: false }, { accepted })),
    ).toBeUndefined();
  });

  it('meets no bound when the rewind would write nothing, whatever the bound and whoever was at work', async () => {
    const quiet = diffOf([object({ touched: 3 })], { activeLastHour: [COLLEAGUE] });

    expect(
      await boundsRefusal(check(quiet, { maxRecords: 1, refuseWhenActive: true })),
    ).toBeUndefined();
  });
});

describe('boundsRefusal — people at work in the org', () => {
  it('refuses a rewind someone other than its writers changed the org for in the hour before, saying how many people and naming none', async () => {
    const refused = await boundsRefusal(check(FOUR, { maxRecords: 10, refuseWhenActive: true }));

    expect(refused).toEqual({
      code: 'PEOPLE_ACTIVE',
      message:
        "1 person other than the user the rewind writes as changed records of the checkpoint's " +
        'objects in DEV-SB in the hour before the rewind read it: it would take their work back. ' +
        'Rewind refused; run it once they are done, or turn off refuseWhenActive in the step and ' +
        'confirm it again. No record was written.',
    });
    expect(refused?.message).not.toContain('A colleague');
    const two = diffOf(FOUR.objects, { activeLastHour: [COLLEAGUE, '005000000000004AAA'] });
    expect((await boundsRefusal(check(two, { refuseWhenActive: true })))?.message).toMatch(
      /^2 people other than/,
    );
  });

  it('lets through a rewind its own writers alone were at work for — the user it writes as, the org’s Automated Process — an Id of 15 characters naming the same user as one of 18', async () => {
    const own = diffOf(FOUR.objects, { activeLastHour: [SELF.slice(0, 15), AUTOMATED_PROCESS] });

    expect(await boundsRefusal(check(own, { refuseWhenActive: true }))).toBeUndefined();
  });

  it('asks for its writers only when someone was at work and the rewind refuses when people are, and refuses nothing for them without that', async () => {
    const writers = vi.fn(() => Promise.resolve([SELF]));

    expect(
      await boundsRefusal(check(FOUR, { refuseWhenActive: false }, { writers })),
    ).toBeUndefined();
    await boundsRefusal(check(diffOf(FOUR.objects), { refuseWhenActive: true }, { writers }));
    expect(writers).not.toHaveBeenCalled();
  });
});

describe('boundsRefusal — the acceptances and the emails', () => {
  it('refuses for want of an acceptance as the command line does without its flag, naming the step’s setting, and lets it through once given', async () => {
    const remade = diffOf([object({ objectApiName: 'Contact', toRecreate: 2 })]);

    const refused = await boundsRefusal(check(remade, { maxRecords: 5, refuseWhenActive: false }));

    expect(refused?.code).toBe('RECREATE');
    expect(refused?.message).toMatch(
      /Rewind refused; turn on acceptRecreate in the step and confirm it again to rewind all the same\. No record was written\.$/,
    );
    // The command line's words, the same refusal but for what lifts it.
    expect(
      acceptanceRefusal('DEV-SB', { diff: remade }, NOTHING_ACCEPTED, {
        ...REWIND_STEP_WORDS.lift,
        acceptRecreate: 'give --accept-recreate to rewind all the same',
      })?.message.replace(
        'give --accept-recreate',
        'turn on acceptRecreate in the step and confirm it again',
      ),
    ).toBe(refused?.message);
    expect(
      await boundsRefusal(
        check(
          remade,
          { maxRecords: 5, refuseWhenActive: false },
          { accepted: { ...NOTHING_ACCEPTED, acceptRecreate: true } },
        ),
      ),
    ).toBeUndefined();
  });

  it('refuses a rewind whose writes fire automation it does not accept, and one whose automation could not all be read', async () => {
    const fired: ForgeTargetAutomation = {
      ...NO_AUTOMATION,
      objects: [
        {
          objectApiName: 'Account',
          flows: [],
          triggers: [{ name: 'AccountAudit', events: ['afterUpdate'] }],
        },
      ],
    };
    const blind: ForgeTargetAutomation = {
      ...NO_AUTOMATION,
      unread: [{ part: 'flows', reason: 'Tooling API timed out' }],
    };
    const bounds = { maxRecords: 10, refuseWhenActive: false };

    for (const automation of [fired, blind]) {
      const refused = await boundsRefusal({
        ...check(FOUR, bounds),
        preview: { diff: FOUR, automation },
      });
      expect(refused?.code).toBe('AUTOMATION');
      expect(refused?.message).toContain(
        'turn on muteAutomation in the step for what a bypass keeps quiet, or acceptAutomation to ' +
          'let it run, and confirm it again',
      );
      expect(
        await boundsRefusal({
          ...check(FOUR, bounds, { accepted: { ...NOTHING_ACCEPTED, acceptAutomation: true } }),
          preview: { diff: FOUR, automation },
        }),
      ).toBeUndefined();
    }
  });

  it('counts once what fires on two of its writes: a flow on an order’s creation and update, as it makes the order again, then gives it its status back (GC4-C2)', async () => {
    const remade = diffOf([object({ objectApiName: 'Order', toRecreate: 1 })]);
    const onSave: ForgeTargetAutomation = {
      ...NO_AUTOMATION,
      objectsRead: ['Order'],
      objects: [
        {
          objectApiName: 'Order',
          flows: [
            {
              apiName: 'Order_Saved',
              label: 'Order saved',
              timing: 'afterSave',
              startsOn: 'createAndUpdate',
              condition: 'read',
              permissions: [],
            },
          ],
          triggers: [],
        },
      ],
    };

    const refused = acceptanceRefusal(
      'DEV-SB',
      { diff: remade, automation: onSave },
      { ...NOTHING_ACCEPTED, acceptRecreate: true },
      REWIND_STEP_WORDS.lift,
    );

    expect(refused?.code).toBe('AUTOMATION');
    expect(refused?.message).toMatch(
      /^DEV-SB: 1 flow\(s\), trigger\(s\) or rule\(s\) of Order run as the rewind brings records back, makes them again, gives them their values back or deletes them\./,
    );
  });

  it('refuses a rewind whose writes would send more emails than a Developer Edition has left today, whatever it accepts', async () => {
    const emails: CheckpointEmails[] = [
      {
        limit: 'SingleEmail',
        emails: 4,
        verdict: 'exceeds',
        remaining: 1,
        max: 15,
        alertsCounted: true,
        objects: [],
      },
    ];
    const everything = {
      acceptAutomation: true,
      acceptNoUndo: true,
      acceptRecreate: true,
      acceptUnseen: true,
    };

    const refused = await boundsRefusal({
      ...check(FOUR, { maxRecords: 10, refuseWhenActive: false }, { accepted: everything }),
      preview: { diff: FOUR, automation: NO_AUTOMATION, emails },
    });

    expect(refused?.code).toBe('EMAILS');
    expect(refused?.message).toContain(
      'about 4 single emails (its email alerts among them, as a Developer Edition counts them), 1 of 15 left today',
    );
  });
});

describe('boundsRefusal — the emails the org delivers', () => {
  /** A flow that emails an owner as an account is updated: what a rewind of {@link FOUR} starts. */
  const SENDING: ForgeTargetAutomation = {
    objectsRead: ['Account'],
    objects: [
      {
        objectApiName: 'Account',
        flows: [
          {
            apiName: 'Account_changed',
            label: 'Account changed',
            timing: 'afterSave',
            startsOn: 'update',
            condition: 'read',
            permissions: [],
            messages: [{ kind: 'email', name: 'Tell owner', limit: 'SingleEmail' }],
          },
        ],
        triggers: [],
      },
    ],
    unread: [],
    conditionsNotRead: 0,
    conditionsBound: 0,
    requests: 0,
  };
  const SENDER = {
    objectApiName: 'Account',
    kind: 'flow' as const,
    name: 'Account changed',
    why: 'email' as const,
  };
  const accepted = {
    acceptAutomation: true,
    acceptNoUndo: true,
    acceptRecreate: true,
    acceptUnseen: true,
  };
  const of = (reading: { level: 'all' } | { level: 'withheld' } | { unread: string }) =>
    acceptanceRefusal(
      'DEV-SB',
      { diff: FOUR, automation: SENDING, deliverability: { reading, senders: [SENDER] } },
      accepted,
      REWIND_STEP_WORDS.lift,
      undefined,
      REWIND_STEP_WORDS.mutes,
    );

  it('tells a step that already mutes to accept what no bypass keeps quiet, not to turn its mute on', () => {
    const refusalWith = (words: typeof REWIND_STEP_WORDS) =>
      acceptanceRefusal(
        'DEV-SB',
        {
          diff: FOUR,
          automation: SENDING,
          deliverability: { reading: { level: 'withheld' }, senders: [SENDER] },
        },
        { ...accepted, acceptAutomation: false },
        words.lift,
        undefined,
        words.mutes,
      );
    const muting = refusalWith(REWIND_MUTING_STEP_WORDS);
    expect(muting?.message).toContain('turn on acceptAutomation in the step');
    expect(muting?.message).not.toContain('turn on muteAutomation');
    expect(refusalWith(REWIND_STEP_WORDS)?.message).toContain('turn on muteAutomation');
  });

  it('refuses an org that delivers them, naming the step’s setting, though its automation was accepted', () => {
    const refusal = of({ level: 'all' });

    expect(refusal?.code).toBe('EMAILS_DELIVERED');
    expect(refusal?.message).toContain(
      'Turn on acceptEmails in the step and confirm it again to rewind all the same',
    );
    expect(refusal?.message).not.toContain('--accept-emails');
  });

  it('refuses an org that would not say, the reason said, and nothing of an org that withholds them', () => {
    expect(of({ unread: 'the org answered: no' })?.message).toContain(
      'could not be read (the org answered: no)',
    );
    expect(of({ level: 'withheld' })).toBeUndefined();
  });

  it('lets the rewind through once the emails are accepted, and asks nothing when nothing sends', () => {
    expect(
      acceptanceRefusal(
        'DEV-SB',
        {
          diff: FOUR,
          automation: SENDING,
          deliverability: { reading: { level: 'all' }, senders: [SENDER] },
        },
        { ...accepted, acceptEmails: true },
        REWIND_STEP_WORDS.lift,
      ),
    ).toBeUndefined();
    expect(
      acceptanceRefusal(
        'DEV-SB',
        { diff: FOUR, automation: { ...SENDING, objects: [] } },
        accepted,
        REWIND_STEP_WORDS.lift,
      ),
    ).toBeUndefined();
  });

  it('leaves a preview that read none to the rewind’s own read: it found nothing that sends', () => {
    expect(
      acceptanceRefusal(
        'DEV-SB',
        { diff: FOUR, automation: SENDING },
        accepted,
        REWIND_STEP_WORDS.lift,
      ),
    ).toBeUndefined();
  });

  it('comes before the daily limit, which its own acceptance does not lift', async () => {
    const emails: CheckpointEmails[] = [
      { limit: 'SingleEmail', emails: 3, objects: [], verdict: 'exceeds', remaining: 1, max: 15 },
    ];
    const check = (acceptEmails: boolean) =>
      boundsRefusal({
        orgName: 'DEV-SB',
        preview: {
          diff: FOUR,
          automation: SENDING,
          emails,
          deliverability: { reading: { level: 'all' }, senders: [SENDER] },
        },
        bounds: { refuseWhenActive: false },
        accepted: { ...accepted, acceptEmails },
        writers: () => Promise.resolve([SELF]),
        words: REWIND_STEP_WORDS,
      });

    expect((await check(false))?.code).toBe('EMAILS_DELIVERED');
    expect((await check(true))?.code).toBe('EMAILS');
  });
});

describe('the counts of a rewind of some objects', () => {
  it('counts what the plan of the objects picked acts on, not the whole preview', () => {
    const plan: RewindSelectionPlan = {
      objects: ['Case'],
      acts: [
        {
          objectApiName: 'Case',
          picked: true,
          toDelete: 1,
          toGiveBack: 0,
          toBringBack: 0,
          toRecreate: 0,
        },
      ],
      left: [{ objectApiName: 'Case', reason: 'holdsLeft', count: 1 }],
      needs: [],
      undoCannot: [],
    };

    expect(previewTotals(selectionDiff(FOUR, plan))).toEqual({
      toDelete: 1,
      toGiveBack: 0,
      toBringBack: 0,
      toRecreate: 0,
    });
  });
});

describe('the refusals of a rewind nobody can be asked about', () => {
  it('names the objects its user may not delete, and says nothing was written — or that a first pass wrote, which stays', () => {
    const objects = [
      { objectApiName: 'Case', records: 2 },
      { objectApiName: 'Account', records: 1 },
    ];

    const before = undeletableUnattendedRefusal('DEV-SB', objects, false);
    expect(before).toEqual({
      code: 'UNDELETABLE_UNATTENDED',
      message:
        'The user SandForge connects to DEV-SB as may not delete the Case (2), Account (1) ' +
        'record(s) this rewind deletes. With nobody to ask whether to delete the rest, the ' +
        'deletion was left untouched. Give the user Delete on those objects, or rewind from the ' +
        'Checkpoints page, which asks. No record was written.',
    });
    expect(undeletableUnattendedRefusal('DEV-SB', objects, true).message).toMatch(
      /What the rewind's first pass wrote stays: its result says what, and Undo takes it back\.$/,
    );
  });

  it('says a step never confirmed, or changed since it was, is confirmed by typing the org’s alias on it', () => {
    expect(notConfirmedRefusal('Nightly reset', true)).toEqual({
      code: 'NOT_CONFIRMED',
      message:
        'Rewind step "Nightly reset" has not been confirmed since it was changed: open it and ' +
        "type the org's alias, or, for an org that has none, its name or Organization Id. No record was written.",
    });
    expect(notConfirmedRefusal('Nightly reset', false).message).toMatch(
      /^Rewind step "Nightly reset" has never been confirmed: /,
    );
  });
});
