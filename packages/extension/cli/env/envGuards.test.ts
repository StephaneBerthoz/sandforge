import { describe, expect, it } from 'vitest';
import type { EnvTargets } from '@sandforge/shared';
import {
  checkpointActRefusal,
  envTargetOf,
  lockRefusal,
  noStateGuard,
  sameOrganization,
  stateRefusal,
  stateTargetRefusal,
  storeRefusal,
  targetRefusal,
  type EnvTarget,
} from './envGuards.js';
import { EnvStateError } from './envState.js';

/*
 * What an environment refuses before any record of the org is read or
 * written: each guard a test of its own, each named after what it refuses.
 */

const ORG = '00Dxx0000001234EAA';
const ORG_15 = '00Dxx0000001234';
const OTHER = '00Dxx0000005678EAA';

const SESSION = { username: 'test-user@example.com' };

const targets = (over: Partial<EnvTargets> = {}): EnvTargets => ({
  kinds: ['scratch', 'developer'],
  sandboxes: [],
  protect: [],
  ...over,
});

function target(kind: EnvTarget['kind'], organizationId = ORG): EnvTarget {
  return { alias: 'TGT', organizationId, kind, username: SESSION.username };
}

describe('a production org', () => {
  it('is refused as read live, with no flag to lift it, whatever the registry or the CLI says', () => {
    const typed = envTargetOf(
      'TGT',
      { id: ORG, sandbox: false, edition: 'Enterprise Edition' },
      { ...SESSION, scratch: true },
    );

    expect(typed).toEqual({
      refusal: {
        code: 'PRODUCTION',
        message: expect.stringContaining(
          'TGT is a production org (its Organization record says IsSandbox false, edition ' +
            'Enterprise Edition)',
        ),
        exit: 1,
      },
    });
    expect('refusal' in typed && typed.refusal.message).toContain('No flag lifts this');
  });

  it('is what an org that says no edition is, and one that will not say what it is', () => {
    expect(envTargetOf('TGT', { id: ORG, sandbox: false }, SESSION)).toMatchObject({
      refusal: { code: 'PRODUCTION', message: expect.stringContaining('and no edition') },
    });
    expect(envTargetOf('TGT', { unread: 'INVALID_SESSION_ID' }, SESSION)).toMatchObject({
      refusal: {
        code: 'PRODUCTION',
        message: expect.stringContaining('TGT did not say what org it is (INVALID_SESSION_ID)'),
      },
    });
  });
});

describe('the kind of org', () => {
  it('types a Developer Edition, a scratch org by the Dev Hub the CLI names, and any other sandbox as one', () => {
    expect(
      envTargetOf('TGT', { id: ORG, sandbox: false, edition: 'Developer Edition' }, SESSION),
    ).toEqual({ target: { ...target('developer'), alias: 'TGT' } });
    expect(envTargetOf('TGT', { id: ORG, sandbox: true }, { ...SESSION, scratch: true })).toEqual({
      target: target('scratch'),
    });
    expect(envTargetOf('TGT', { id: ORG, sandbox: true }, SESSION)).toEqual({
      target: target('sandbox'),
    });
  });

  it('is refused when the file’s targets.kinds does not allow it', () => {
    const refused = targetRefusal(targets({ kinds: ['scratch'] }), target('developer'));

    expect(refused).toEqual({
      code: 'KIND',
      message: expect.stringContaining(
        "TGT is a Developer Edition org, and the file's targets.kinds allows scratch",
      ),
      exit: 1,
    });
    expect(targetRefusal(targets(), target('developer'))).toBeUndefined();
    expect(targetRefusal(targets(), target('scratch'))).toBeUndefined();
  });

  it('says of a sandbox refused by kind that a scratch org the CLI named no Dev Hub for reads as one', () => {
    expect(targetRefusal(targets(), target('sandbox'))?.message).toContain(
      'If it is a scratch org, the sf CLI did not say so',
    );
  });
});

describe('a sandbox', () => {
  const allowed = targets({ kinds: ['scratch', 'developer', 'sandbox'], sandboxes: [ORG_15] });

  it('is written to only when its Organization Id is in targets.sandboxes, in either form', () => {
    expect(targetRefusal(allowed, target('sandbox'))).toBeUndefined();
    expect(
      targetRefusal(targets({ kinds: ['sandbox'], sandboxes: [ORG] }), target('sandbox', ORG_15)),
    ).toBeUndefined();
  });

  it('is refused when another one is listed, as a sandbox refreshed since, whose Id changed', () => {
    const refused = targetRefusal(allowed, target('sandbox', OTHER));

    expect(refused).toEqual({
      code: 'NOT_LISTED',
      message: expect.stringContaining(
        `TGT is a sandbox, and its Organization Id ${OTHER} is not listed under targets.sandboxes`,
      ),
      exit: 1,
    });
    expect(refused?.message).toContain('A refresh changes the Id');
  });
});

describe('a protected org', () => {
  it('is refused whatever else the file says, the kinds and the sandboxes listed included', () => {
    const file = targets({
      kinds: ['scratch', 'developer', 'sandbox'],
      sandboxes: [ORG],
      protect: [ORG_15],
    });

    for (const kind of ['scratch', 'developer', 'sandbox'] as const) {
      expect(targetRefusal(file, target(kind))).toEqual({
        code: 'PROTECTED',
        message: `TGT (${ORG}) is listed under targets.protect: the file refuses it whatever else it says. Nothing was read or written.`,
        exit: 1,
      });
    }
    expect(targetRefusal(file, target('scratch', OTHER))).toBeUndefined();
  });
});

describe('a state of another org', () => {
  it('is refused, never applied, when the store finds one copied into the org’s folder', () => {
    expect(stateRefusal(new EnvStateError('otherOrg', 'The state … is of another org.'))).toEqual({
      code: 'OTHER_ORG',
      message: 'The state … is of another org. Nothing was read or written in the org.',
      exit: 1,
    });
    expect(stateRefusal(new EnvStateError('damaged', 'Does not read.')).code).toBe('STATE_DAMAGED');
  });

  it('is refused when the state read names another org or another environment than the line and the file', () => {
    const state = { env: 'case-flow', org: { organizationId: ORG } };

    expect(stateTargetRefusal(state, 'case-flow', target('scratch', ORG_15))).toBeUndefined();
    expect(stateTargetRefusal(state, 'case-flow', target('scratch', OTHER))).toMatchObject({
      code: 'OTHER_ORG',
      message: expect.stringContaining('a state of another org is never applied'),
    });
    expect(stateTargetRefusal(state, 'demo', target('scratch'))?.code).toBe('OTHER_ORG');
  });
});

describe('no state of the environment on this machine', () => {
  it('refuses a Developer Edition org or a sandbox without --accept-no-state, which lets it through, warned', () => {
    for (const kind of ['developer', 'sandbox'] as const) {
      const refused = noStateGuard(target(kind), 'case-flow', false);
      expect(refused).toEqual({
        refusal: {
          code: 'NO_STATE',
          message: expect.stringContaining(
            'This machine keeps no state of case-flow on TGT: records an earlier apply left there',
          ),
          exit: 1,
        },
      });
      expect('refusal' in refused && refused.refusal.message).toContain('--accept-no-state');
      expect(noStateGuard(target(kind), 'case-flow', true)).toEqual({
        warning: expect.stringContaining('would be created twice'),
      });
    }
  });

  it('only warns of a scratch org, which lives as long as the job that applies to it', () => {
    expect(noStateGuard(target('scratch'), 'case-flow', false)).toEqual({
      warning: expect.stringContaining('this machine keeps no state of case-flow on TGT'),
    });
  });
});

describe('the store inside the repository', () => {
  it('stops the verb before any org is reached, exit 2; another store refusal is a refusal, exit 1', () => {
    expect(storeRefusal('The journal directory … is inside the repository', true)).toEqual({
      code: 'STORE_IN_REPOSITORY',
      message: 'The journal directory … is inside the repository',
      exit: 2,
    });
    expect(storeRefusal('… belongs to another user', false)).toMatchObject({
      code: 'STORE',
      exit: 1,
    });
  });
});

describe('the env lock and a checkpoint act under way', () => {
  it('refuses an apply while another holds the org, naming who and since when', () => {
    expect(
      lockRefusal({
        operation: 'apply',
        env: 'case-flow',
        alias: 'pool-1',
        host: 'ci-runner',
        pid: 4242,
        hostStartedAt: '2026-10-25T10:00:00.000Z',
        acquiredAt: '2026-10-25T11:00:00.000Z',
      }),
    ).toEqual({
      code: 'LOCKED',
      message: expect.stringContaining(
        'an apply of case-flow to pool-1 is under way on this machine (process 4242 on ' +
          'ci-runner, since 2026-10-25T11:00:00.000Z)',
      ),
      exit: 1,
    });
  });

  it('refuses a step while a checkpoint take, rewind or undo of the org runs', () => {
    expect(checkpointActRefusal('a checkpoint rewind of this org is under way')).toEqual({
      code: 'CHECKPOINT_ACT',
      message: 'A checkpoint rewind of this org is under way',
      exit: 1,
    });
  });
});

describe('two Organization Ids', () => {
  it('name one org in either form, and no shorter word does', () => {
    expect(sameOrganization(ORG, ORG_15)).toBe(true);
    expect(sameOrganization(ORG, OTHER)).toBe(false);
    expect(sameOrganization('pool-1', 'pool-1')).toBe(false);
  });
});
