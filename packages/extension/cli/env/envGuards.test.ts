import { describe, expect, it } from 'vitest';
import type { EnvTargets } from '@sandforge/shared';
import {
  checkpointActRefusal,
  envTargetOf,
  lockRefusal,
  myDomainListingWords,
  noStateGuard,
  refreshedStateWords,
  sameOrganization,
  sandboxListing,
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

/** The host a sandbox of the My Domain acme--uat answers on, with enhanced domains. */
const SANDBOX_HOST = 'acme--uat.sandbox.my.salesforce.com';

/** A sandbox as the guards typed it, on a host, or on none that is a My Domain's. */
function sandboxOn(host: string | undefined, organizationId = ORG): EnvTarget {
  return { ...target('sandbox', organizationId), ...(host !== undefined ? { host } : {}) };
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
    expect(envTargetOf('TGT', { unread: 'MALFORMED_QUERY' }, SESSION)).toMatchObject({
      refusal: {
        code: 'PRODUCTION',
        message: expect.stringContaining('TGT did not say what org it is (MALFORMED_QUERY)'),
      },
    });
  });

  it('says what lets an org it could not type be read — the sign-in to renew, the org to wait for, View Setup — and no flag it lacks', () => {
    const expired = Object.assign(new Error('Session expired or invalid'), {
      errorCode: 'INVALID_SESSION_ID',
    });
    const typed = envTargetOf('TGT', { unread: expired.message, error: expired }, SESSION);

    expect(typed).toEqual({
      refusal: {
        code: 'UNTYPED',
        message:
          'TGT refused the session sf gave for it (Session expired or invalid), and sandforge ' +
          'env writes to no org it cannot tell from a production one. "sf org display ' +
          '--target-org TGT" says what sf holds for it; "sf org login web --alias TGT" signs in ' +
          'again (in a CI job, "sf org login jwt" or "sf org login sfdx-url"); then run the ' +
          'command again. Nothing was written.',
        exit: 1,
      },
    });
    const silent = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    expect(envTargetOf('TGT', { unread: silent.message, error: silent }, SESSION)).toMatchObject({
      refusal: { code: 'UNTYPED', message: expect.stringMatching(/^TGT did not answer/) },
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

describe('the host an org answers on', () => {
  it('is the My Domain host the sf CLI reaches it by, and none for a pod’s host, which many orgs share', () => {
    expect(
      envTargetOf(
        'TGT',
        { id: ORG, sandbox: true },
        { ...SESSION, instanceUrl: 'https://Acme--UAT.sandbox.my.salesforce.com' },
      ),
    ).toEqual({ target: sandboxOn(SANDBOX_HOST) });

    const onPod = envTargetOf(
      'TGT',
      { id: ORG, sandbox: true },
      { ...SESSION, instanceUrl: 'https://cs42.salesforce.com' },
    );
    expect(onPod).toEqual({ target: target('sandbox') });
    expect('target' in onPod && 'host' in onPod.target).toBe(false);
  });
});

describe('a sandbox listed by its My Domain', () => {
  const byMyDomain = targets({ kinds: ['sandbox'], sandboxes: [{ myDomain: 'acme--uat' }] });

  it('is written to when it answers IsSandbox true, the CLI shows no scratch org, and its host is of that My Domain, whatever its Id', () => {
    const typed = envTargetOf(
      'TGT',
      { id: ORG, sandbox: true },
      { ...SESSION, instanceUrl: `https://${SANDBOX_HOST}` },
    );
    if (!('target' in typed)) throw new Error('refused');

    expect(targetRefusal(byMyDomain, typed.target)).toBeUndefined();
    expect(targetRefusal(byMyDomain, sandboxOn(SANDBOX_HOST, OTHER))).toBeUndefined();
    expect(
      targetRefusal(byMyDomain, sandboxOn('acme--uat.cs42.my.salesforce.com')),
    ).toBeUndefined();
    expect(sandboxListing(byMyDomain, typed.target)).toEqual({
      by: 'myDomain',
      myDomain: 'acme--uat',
    });
  });

  it('never lists a scratch org, by its host when the CLI did not say it is one, by its kind when it did', () => {
    const scratchHost = 'acme--uat.scratch.my.salesforce.com';
    const unsaid = targetRefusal(byMyDomain, sandboxOn(scratchHost));

    expect(unsaid).toMatchObject({ code: 'NOT_LISTED', exit: 1 });
    expect(unsaid?.message).toContain(
      `Its host, ${scratchHost}, is a scratch org's, which no My Domain lists`,
    );
    expect(unsaid?.message).not.toContain('which a refresh keeps');
    expect(sandboxListing(byMyDomain, sandboxOn(scratchHost))).toBeUndefined();

    const said = envTargetOf(
      'TGT',
      { id: ORG, sandbox: true },
      { ...SESSION, scratch: true, instanceUrl: `https://${SANDBOX_HOST}` },
    );
    if (!('target' in said)) throw new Error('refused');
    expect(targetRefusal(byMyDomain, said.target)?.code).toBe('KIND');
  });

  it('never lists a Developer Edition org nor a production org, whose IsSandbox read live is false', () => {
    const onSandboxHost = { ...SESSION, instanceUrl: `https://${SANDBOX_HOST}` };
    const developer = envTargetOf(
      'TGT',
      { id: ORG, sandbox: false, edition: 'Developer Edition' },
      onSandboxHost,
    );
    if (!('target' in developer)) throw new Error('refused');

    expect(targetRefusal(byMyDomain, developer.target)?.code).toBe('KIND');
    expect(sandboxListing(byMyDomain, developer.target)).toBeUndefined();
    expect(
      envTargetOf('TGT', { id: ORG, sandbox: false, edition: 'Enterprise Edition' }, onSandboxHost),
    ).toMatchObject({ refusal: { code: 'PRODUCTION' } });
  });

  it('refuses a sandbox of another My Domain, and one the CLI reaches by no My Domain host', () => {
    const other = targetRefusal(byMyDomain, sandboxOn('acme--qa.sandbox.my.salesforce.com'));
    expect(other).toMatchObject({ code: 'NOT_LISTED', exit: 1 });
    expect(other?.message).toContain(
      `TGT is a sandbox, and its Organization Id ${ORG} is not listed under targets.sandboxes, ` +
        'nor its My Domain acme--qa',
    );

    const unhosted = targetRefusal(byMyDomain, sandboxOn(undefined));
    expect(unhosted).toMatchObject({ code: 'NOT_LISTED', exit: 1 });
    expect(unhosted?.message).toContain(
      'The sf CLI reaches it by no My Domain host: no My Domain the file lists can name it.',
    );
    expect(unhosted?.message).not.toContain('which a refresh keeps');

    const otherShape = targetRefusal(byMyDomain, sandboxOn('example.my.salesforce.com'));
    expect(otherShape?.message).toContain(
      "Its host, example.my.salesforce.com, is no sandbox's: no My Domain the file lists can name it.",
    );
  });

  it('says of a sandbox on a host of no sandbox’s shape what it said before, when the file lists Ids alone', () => {
    expect(
      targetRefusal(
        targets({ kinds: ['sandbox'], sandboxes: [OTHER] }),
        sandboxOn('example.my.salesforce.com'),
      ),
    ).toEqual({
      code: 'NOT_LISTED',
      message:
        `TGT is a sandbox, and its Organization Id ${ORG} is not listed under ` +
        "targets.sandboxes: nothing Salesforce says tells a sandbox that holds a client's " +
        "records from a developer's, so each one the file writes to is listed, reviewed with " +
        'the file. A refresh changes the Id: a sandbox listed before its refresh is listed ' +
        'again. Nothing was read or written. If it is a scratch org, the sf CLI did not say ' +
        'so: its display names no Dev Hub for it, as when the org was logged in with an auth ' +
        'URL alone.',
      exit: 1,
    });
  });

  it('names, when it refuses a sandbox, the My Domain that would list it after each refresh', () => {
    const refused = targetRefusal(
      targets({ kinds: ['sandbox'], sandboxes: [ORG] }),
      sandboxOn(SANDBOX_HOST, OTHER),
    );

    expect(refused?.message).toContain(
      'A refresh changes the Id: a sandbox listed by it before its refresh is listed again, or ' +
        'listed by its My Domain, which a refresh keeps: { myDomain: acme--uat }.',
    );
    expect(refused?.message).not.toContain('If it is a scratch org');
  });

  it('is said listed by its Organization Id when the file lists it both ways, and by its My Domain alone otherwise', () => {
    const both = targets({
      kinds: ['sandbox'],
      sandboxes: [{ myDomain: 'acme--uat' }, ORG_15],
    });

    expect(sandboxListing(both, sandboxOn(SANDBOX_HOST))).toEqual({ by: 'organizationId' });
    expect(sandboxListing(both, sandboxOn(SANDBOX_HOST, OTHER))).toEqual({
      by: 'myDomain',
      myDomain: 'acme--uat',
    });
    expect(sandboxListing(both, target('developer'))).toBeUndefined();
  });

  it('is said in the plan, and so is an Organization Id changed since the last apply', () => {
    expect(myDomainListingWords(false)).toBe('listed by its My Domain');
    expect(myDomainListingWords(true)).toBe(
      'listed by its My Domain; its Organization Id changed since the last apply',
    );
  });
});

describe('an org protected by its My Domain', () => {
  const protectedUat = (sandboxes: EnvTargets['sandboxes']): EnvTargets =>
    targets({
      kinds: ['scratch', 'developer', 'sandbox'],
      sandboxes,
      protect: [{ myDomain: 'acme--uat' }],
    });

  it('refuses the sandbox on that My Domain, whether the file lists it by its Id or by its My Domain', () => {
    for (const listed of [[ORG], [{ myDomain: 'acme--uat' }]]) {
      expect(targetRefusal(protectedUat(listed), sandboxOn(SANDBOX_HOST))).toEqual({
        code: 'PROTECTED',
        message:
          `TGT (${ORG}, on ${SANDBOX_HOST}) is listed under targets.protect by its My Domain ` +
          'acme--uat: the file refuses it whatever else it says. Nothing was read or written.',
        exit: 1,
      });
    }
  });

  it('lets another sandbox, a scratch org and a Developer Edition org through', () => {
    const file = protectedUat([{ myDomain: 'acme--qa' }]);

    expect(targetRefusal(file, sandboxOn('acme--qa.sandbox.my.salesforce.com'))).toBeUndefined();
    expect(targetRefusal(file, target('scratch'))).toBeUndefined();
    expect(targetRefusal(file, target('developer'))).toBeUndefined();
  });

  it('refuses a sandbox the CLI reaches by no My Domain host, which it cannot tell from the one protected', () => {
    const refused = targetRefusal(protectedUat([ORG]), sandboxOn(undefined));

    expect(refused).toMatchObject({ code: 'PROTECTED', exit: 1 });
    expect(refused?.message).toContain(
      `TGT (${ORG}) is a sandbox the sf CLI reaches by no My Domain host, and targets.protect ` +
        'lists acme--uat by its My Domain: whether it is that sandbox cannot be told, and a ' +
        'protected org is never let through on a guess.',
    );
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

  it('says state recover rebuilds the state when the journal directory keeps runs of the environment, and nothing of it when it keeps none', () => {
    const hint =
      'it keeps runs of case-flow on TGT, and pnpm exec tsx packages/extension/cli/sandforge-env.ts state recover rebuilds the state from them';
    const kept = noStateGuard(target('developer'), 'case-flow', false, true);
    expect('refusal' in kept && kept.refusal.message).toContain(hint);
    expect('refusal' in kept && kept.refusal.message).toContain('--accept-no-state');
    expect(noStateGuard(target('scratch'), 'case-flow', false, true)).toEqual({
      warning: expect.stringContaining(hint),
    });
    const none = noStateGuard(target('developer'), 'case-flow', false);
    expect('refusal' in none && none.refusal.message).not.toContain('state recover');
  });

  const keptBefore = {
    organizationId: OTHER,
    serial: 9,
    updatedAt: '2026-11-14T17:47:50.000Z',
    host: SANDBOX_HOST,
    setAside: `/home/dev/.sandforge/env/${OTHER}/case-flow`,
  };

  it('asks no --accept-no-state of a sandbox refreshed since the last apply, proven by the state kept under its former Id on the same host, and names that state, set aside', () => {
    const guarded = noStateGuard(sandboxOn(SANDBOX_HOST), 'case-flow', false, false, keptBefore);

    expect(guarded).toEqual({
      warning:
        `none for this Organization Id; TGT was refreshed since the last apply, which this ` +
        `machine kept under ${OTHER} (serial 9, 2026-11-14): the refresh took what it held, and ` +
        `this apply starts anew. That state is set aside, kept: /home/dev/.sandforge/env/${OTHER}/case-flow`,
      refreshed: {
        organizationId: OTHER,
        serial: 9,
        updatedAt: '2026-11-14T17:47:50.000Z',
        setAside: `/home/dev/.sandforge/env/${OTHER}/case-flow`,
      },
    });
    expect(refreshedStateWords('TGT', keptBefore)).toBe('warning' in guarded && guarded.warning);
    expect(noStateGuard(sandboxOn(SANDBOX_HOST), 'case-flow', true, false, keptBefore)).toEqual(
      guarded,
    );
  });

  it('asks it as before when nothing proves the refresh: the same Id, another host, no host, runs of this Id kept, or another kind of org', () => {
    const cases: Array<[string, EnvTarget, typeof keptBefore, boolean]> = [
      ['the same Id', sandboxOn(SANDBOX_HOST, OTHER), keptBefore, false],
      ['another host', sandboxOn('acme--qa.sandbox.my.salesforce.com'), keptBefore, false],
      ['no host for the org', sandboxOn(undefined), keptBefore, false],
      ['runs of this Id kept: its state lost', sandboxOn(SANDBOX_HOST), keptBefore, true],
      [
        'a Developer Edition org',
        { ...target('developer'), host: SANDBOX_HOST },
        keptBefore,
        false,
      ],
    ];
    for (const [why, org, kept, runsKept] of cases) {
      const guarded = noStateGuard(org, 'case-flow', false, runsKept, kept);
      expect('refusal' in guarded && guarded.refusal.code, why).toBe('NO_STATE');
    }
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
