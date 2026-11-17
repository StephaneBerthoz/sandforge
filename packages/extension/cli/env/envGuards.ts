/**
 * What an environment refuses to be applied to, planned against or taken back
 * from, before any record of the org is read or written.
 *
 * Every write of an environment is a script's, and every script refuses a
 * production org on its own. The environment refuses more, and earlier, for
 * what no script can know:
 *
 * - **a production org**, typed live from its Organization record, and an org
 *   that will not say what it is: no flag lifts it;
 * - **a kind of org the file does not allow** (`targets.kinds`): scratch orgs
 *   and Developer Edition orgs unless it says otherwise;
 * - **a sandbox the file does not list** (`targets.sandboxes`), by its
 *   Organization Id or by its My Domain: nothing Salesforce says tells a full
 *   copy holding a client's records from a developer's sandbox, and the
 *   command lines never see Org Manager's Staging mark. A refresh changes the
 *   Id and keeps the My Domain, so a sandbox listed by its Id is refused after
 *   a refresh until someone lists it again, and one listed by its My Domain is
 *   not ({@link sandboxListing});
 * - **a protected org** (`targets.protect`), by its Id or by its My Domain,
 *   whatever else says;
 * - **a state filed under another org**, or one that does not read: a destroy
 *   would take back records of an org it does not describe;
 * - **no state on a Developer Edition org or a sandbox** without
 *   `--accept-no-state`: an earlier apply's records cannot be told from the
 *   org's own, and would be created twice. A scratch org usually lives as long
 *   as the job that applies to it: it is warned of, not refused. A sandbox
 *   whose state this machine kept under its former Id, on the same host, was
 *   refreshed since: what the state named went with the refresh, and no flag
 *   is asked;
 * - **the journal directory inside the file's repository**, where the state
 *   and the run summaries would be committed;
 * - **another apply, destroy or reset of the org, or a checkpoint act**, under
 *   way on this machine.
 *
 * A scratch org says `IsSandbox` true, as a sandbox does: only the `sf` CLI
 * tells them apart, by the Dev Hub its display names. An org the CLI does not
 * show as a scratch org is a sandbox here, and refused unless listed — the
 * safe side of a question the org itself cannot answer. A My Domain never
 * lists one on a scratch org's host (`envTargetHost.ts`).
 */

import type { EnvPlanRefreshed, EnvState, EnvTargetKind, EnvTargets } from '@sandforge/shared';
import {
  isProductionTarget,
  untypedCauseOf,
  type TypedTarget,
} from '../../src/core/precheck/orgKindLive.js';
import { organizationKey } from '../../src/modules/checkpoint/OrgCheckpointStore.js';
import type { EnvStateError, EnvStateRefreshed } from './envState.js';
import {
  hostIsMyDomain,
  isScratchHost,
  myDomainHostOf,
  refreshedSince,
  sandboxMyDomainOf,
} from './envTargetHost.js';
import { envLockRefusal, type EnvLockHolder } from './envLock.js';
import { commandOf } from '../invocation.js';
import { untypedTargetRefusal } from '../targetKind.js';

/**
 * The code an apply or a destroy is refused with when the state changed
 * since its plan: another apply or destroy ran, or a cache put back another.
 */
export const STATE_MOVED = 'STATE_MOVED';

/** What refused, in a word a pipeline reads. */
export type EnvRefusalCode =
  | typeof STATE_MOVED
  | 'PRODUCTION'
  /**
   * The org could not be typed for a cause something lifts — a sign-in to
   * renew, an org that did not answer, View Setup to give — said with it.
   */
  | 'UNTYPED'
  | 'PROTECTED'
  | 'KIND'
  | 'NOT_LISTED'
  | 'OTHER_ORG'
  | 'STATE_DAMAGED'
  | 'NO_STATE'
  | 'STORE_IN_REPOSITORY'
  | 'STORE'
  | 'LOCKED'
  | 'CHECKPOINT_ACT'
  | 'NO_CHECKPOINT'
  | 'MASKED'
  | 'BAD_LINE'
  | 'PLAN_UNREAD'
  | 'PLAN_IN_REPOSITORY'
  | 'PLAN_REFUSED'
  | 'PLAN_OTHER_ORG'
  | 'PLAN_STALE'
  | 'TWO_STATES'
  /** `state recover`: a state that reads, which it never writes over. */
  | 'STATE_KEPT'
  /** `state recover`: a state a later SandForge wrote. */
  | 'STATE_NEWER'
  /** `state recover`: a run's summary, or a seed run file, that does not read. */
  | 'RUN_UNREAD'
  /** `state recover`: a summary or a sas of another org. */
  | 'RUN_OTHER_ORG'
  /** `state recover`: two runs of one rank, or two kinds of one resource. */
  | 'RUNS_CONFLICT'
  /** `state recover`: a seed run of a resource that may be another environment's. */
  | 'RUN_UNCLAIMED'
  /** `state recover`: no run of the environment to rebuild a state from. */
  | 'NO_RUNS';

/** A guard's refusal: what refused, in words, and the exit code it ends the verb with. */
export interface EnvRefusal {
  code: EnvRefusalCode;
  message: string;
  /** 1, refused; 2, the setup is wrong before any org is reached (the store inside the repository). */
  exit: 1 | 2;
}

/** The org an environment is applied to, as the guards typed it. */
export interface EnvTarget {
  /** The alias the line named it by. */
  alias: string;
  /** Its Organization Id, as the org gave it. */
  organizationId: string;
  kind: EnvTargetKind;
  username: string;
  /**
   * The My Domain host the `sf` CLI reaches it by, lower-cased: what a sandbox
   * listed by its My Domain is told by. Absent for an org reached on a pod's
   * host, which many orgs share.
   */
  host?: string;
}

/** What is said of a production org's refusal: nothing lifts it. */
const NO_FLAG = 'No flag lifts this: an environment is never applied to a production org.';

/** Whether two Organization Ids name one org: the 15-character id and its 18-character form alike. */
export function sameOrganization(a: string, b: string): boolean {
  return a.length >= 15 && b.length >= 15 && a.slice(0, 15) === b.slice(0, 15);
}

/**
 * The org as the guards take it: a scratch org, a sandbox or a Developer
 * Edition org, or refused as a production org — one typed so live, or one
 * that would not say what it is.
 *
 * @param typed - What the org's Organization record said, or why it said nothing:
 *   the error itself, when there is one, tells a sign-in to renew, an org that
 *   did not answer and a permission to give from an org that said nothing.
 * @param session - Whether the `sf` CLI shows it as a scratch org, its user,
 *   and the instance it reaches the org by, whose My Domain host is kept.
 */
export function envTargetOf(
  alias: string,
  typed: TypedTarget | { unread: string; error?: unknown },
  session: { scratch?: true; username: string; instanceUrl?: string },
): { target: EnvTarget } | { refusal: EnvRefusal } {
  if ('unread' in typed) {
    // "No flag lifts this" was said of an expired sign-in too, which one
    // command lifts: what lifts each cause is said in the clone's words.
    if (typed.error !== undefined && untypedCauseOf(typed.error) !== undefined) {
      return {
        refusal: {
          code: 'UNTYPED',
          message: untypedTargetRefusal(alias, typed.error, {
            tool: 'sandforge env',
            action: 'write',
            readOnly: 'plan',
          }),
          exit: 1,
        },
      };
    }
    return {
      refusal: {
        code: 'PRODUCTION',
        message:
          `${alias} did not say what org it is (${typed.unread}), and an environment is ` +
          `applied to no org it cannot tell from a production one. Nothing was read or ` +
          `written. ${NO_FLAG}`,
        exit: 1,
      },
    };
  }
  if (isProductionTarget(typed)) {
    const said = typed.edition
      ? `IsSandbox false, edition ${typed.edition}`
      : 'IsSandbox false, and no edition';
    return {
      refusal: {
        code: 'PRODUCTION',
        message:
          `${alias} is a production org (its Organization record says ${said}): an ` +
          'environment is applied to scratch orgs, Developer Edition orgs and the sandboxes ' +
          `its file lists. Nothing was read or written. ${NO_FLAG}`,
        exit: 1,
      },
    };
  }
  const kind: EnvTargetKind = typed.sandbox
    ? session.scratch === true
      ? 'scratch'
      : 'sandbox'
    : 'developer';
  const host = myDomainHostOf(session.instanceUrl);
  return {
    target: {
      alias,
      organizationId: typed.id,
      kind,
      username: session.username,
      ...(host !== undefined ? { host } : {}),
    },
  };
}

/** A kind of org as a refusal says it. */
const KIND_WORDS: Readonly<Record<EnvTargetKind, string>> = {
  scratch: 'a scratch org',
  developer: 'a Developer Edition org',
  sandbox: 'a sandbox',
};

/** How the file lets a sandbox through: by its Organization Id, or by its My Domain. */
export type EnvSandboxListing = { by: 'organizationId' } | { by: 'myDomain'; myDomain: string };

/**
 * How `targets.sandboxes` lists the target, or nothing: by its Organization
 * Id, compared on the 15 characters both forms share, which wins when the
 * file names both; else by its My Domain, for an org that answered
 * `IsSandbox` true live, that the CLI does not show as a scratch org, and
 * whose host is that sandbox's — never a scratch org's host. Nothing for
 * another kind of org: the kinds let those through, no listing does.
 */
export function sandboxListing(
  targets: Pick<EnvTargets, 'sandboxes'>,
  target: EnvTarget,
): EnvSandboxListing | undefined {
  if (target.kind !== 'sandbox') return undefined;
  if (
    targets.sandboxes.some(
      (listed) => typeof listed === 'string' && sameOrganization(listed, target.organizationId),
    )
  ) {
    return { by: 'organizationId' };
  }
  const myDomain = sandboxMyDomainOf(target.host);
  if (
    myDomain !== undefined &&
    targets.sandboxes.some((listed) => typeof listed !== 'string' && listed.myDomain === myDomain)
  ) {
    return { by: 'myDomain', myDomain };
  }
  return undefined;
}

/**
 * What a plan says of a sandbox the file lets through by its My Domain, and,
 * when the state this machine kept of it is under another Organization Id,
 * that the Id changed since: a sandbox deleted and made again under its name
 * is let through as a refreshed one is, and the plan is where it is seen.
 */
export function myDomainListingWords(idChanged: boolean): string {
  return idChanged
    ? 'listed by its My Domain; its Organization Id changed since the last apply'
    : 'listed by its My Domain';
}

/**
 * Why `targets.protect` refuses the target, or nothing: its Organization Id;
 * a host of a My Domain it names, whatever kind of host; a sandbox the CLI
 * reaches by no My Domain host while it names a My Domain, which cannot be
 * told from the one it protects. A scratch org or a Developer Edition org is
 * no sandbox, which a My Domain names.
 */
function protectedRefusal(targets: EnvTargets, target: EnvTarget): EnvRefusal | undefined {
  const id = target.organizationId;
  const key = organizationKey(id);
  if (targets.protect.some((entry) => typeof entry === 'string' && sameOrganization(entry, id))) {
    return {
      code: 'PROTECTED',
      message:
        `${target.alias} (${key}) is listed under targets.protect: the file refuses it ` +
        'whatever else it says. Nothing was read or written.',
      exit: 1,
    };
  }
  const myDomains = targets.protect.flatMap((entry) =>
    typeof entry === 'string' ? [] : [entry.myDomain],
  );
  const named = myDomains.find((myDomain) => hostIsMyDomain(target.host, myDomain));
  if (named !== undefined) {
    return {
      code: 'PROTECTED',
      message:
        `${target.alias} (${key}, on ${target.host ?? ''}) is listed under targets.protect by its ` +
        `My Domain ${named}: the file refuses it whatever else it says. Nothing was read or written.`,
      exit: 1,
    };
  }
  if (myDomains.length > 0 && target.kind === 'sandbox' && target.host === undefined) {
    const lists =
      myDomains.length === 1
        ? `lists ${myDomains.join(', ')} by its My Domain: whether it is that sandbox`
        : `lists ${myDomains.join(', ')} by their My Domains: whether it is one of them`;
    return {
      code: 'PROTECTED',
      message:
        `${target.alias} (${key}) is a sandbox the sf CLI reaches by no My Domain host, and ` +
        `targets.protect ${lists} cannot be told, and a protected org is never let through on ` +
        "a guess. Nothing was read or written. Sign in to it by its My Domain's URL to have it " +
        'told apart.',
      exit: 1,
    };
  }
  return undefined;
}

/**
 * The refusal of a sandbox `targets.sandboxes` does not list, with the way to
 * list it that its host leaves: by its My Domain on a sandbox's host; by its
 * Id alone on a scratch org's host, which the CLI did not say is one, or on
 * any other. When the file lists My Domains, it says why none names the org.
 */
function notListedRefusal(targets: Pick<EnvTargets, 'sandboxes'>, target: EnvTarget): EnvRefusal {
  const key = organizationKey(target.organizationId);
  const myDomain = sandboxMyDomainOf(target.host);
  const listsMyDomains = targets.sandboxes.some((listed) => typeof listed !== 'string');
  const why =
    "nothing Salesforce says tells a sandbox that holds a client's records from a developer's, " +
    'so each one the file writes to is listed, reviewed with the file.';
  const scratchHint =
    ' If it is a scratch org, the sf CLI did not say so: its display names no Dev Hub for it, ' +
    'as when the org was logged in with an auth URL alone.';
  if (myDomain !== undefined) {
    return {
      code: 'NOT_LISTED',
      message:
        `${target.alias} is a sandbox, and its Organization Id ${key} is not listed under ` +
        `targets.sandboxes, nor its My Domain ${myDomain}: ${why} A refresh changes the Id: a ` +
        'sandbox listed by it before its refresh is listed again, or listed by its My Domain, ' +
        `which a refresh keeps: { myDomain: ${myDomain} }. Nothing was read or written.`,
      exit: 1,
    };
  }
  const host = isScratchHost(target.host)
    ? ` Its host, ${target.host ?? ''}, is a scratch org's, which no My Domain lists: the sf CLI ` +
      'did not say it is one, its display naming no Dev Hub for it, as when the org was ' +
      'logged in with an auth URL alone. Log its Dev Hub in on this machine.'
    : !listsMyDomains
      ? ''
      : target.host === undefined
        ? ' The sf CLI reaches it by no My Domain host: no My Domain the file lists can name it.'
        : ` Its host, ${target.host}, is no sandbox's: no My Domain the file lists can name it.`;
  return {
    code: 'NOT_LISTED',
    message:
      `${target.alias} is a sandbox, and its Organization Id ${key} is not listed under ` +
      `targets.sandboxes: ${why} A refresh changes the Id: a sandbox listed before its refresh ` +
      `is listed again.${host} Nothing was read or written.` +
      (isScratchHost(target.host) ? '' : scratchHint),
    exit: 1,
  };
}

/**
 * Why the file may not be applied to the target, or nothing when it may: a
 * protected org, a kind of org the file does not allow, or a sandbox it does
 * not list ({@link sandboxListing}). `targets.protect` wins over every other
 * key, a My Domain it names included.
 */
export function targetRefusal(targets: EnvTargets, target: EnvTarget): EnvRefusal | undefined {
  const refused = protectedRefusal(targets, target);
  if (refused !== undefined) return refused;
  if (!targets.kinds.includes(target.kind)) {
    const scratchHint =
      target.kind === 'sandbox'
        ? ' If it is a scratch org, the sf CLI did not say so: its display names no Dev Hub ' +
          'for it, as when the org was logged in with an auth URL alone. Log its Dev Hub in on ' +
          'this machine, or list the org as a sandbox.'
        : '';
    return {
      code: 'KIND',
      message:
        `${target.alias} is ${KIND_WORDS[target.kind]}, and the file's targets.kinds allows ` +
        `${targets.kinds.join(', ')}: add ${target.kind} to targets.kinds to apply it there. ` +
        `Nothing was read or written.${scratchHint}`,
      exit: 1,
    };
  }
  if (target.kind === 'sandbox' && sandboxListing(targets, target) === undefined) {
    return notListedRefusal(targets, target);
  }
  return undefined;
}

/** A state the store would not read, as the verb refuses it. */
export function stateRefusal(error: EnvStateError): EnvRefusal {
  return {
    code: error.code === 'otherOrg' ? 'OTHER_ORG' : 'STATE_DAMAGED',
    message: `${error.message} Nothing was read or written in the org.`,
    exit: 1,
  };
}

/**
 * Why the state may not be used for the target, or nothing: one that names
 * another org or another environment than the file's. The store refuses a
 * state copied into another org's folder; this holds the one it read to the
 * org the line named and the file it is applied from.
 */
export function stateTargetRefusal(
  state: Pick<EnvState, 'env'> & { org: Pick<EnvState['org'], 'organizationId'> },
  env: string,
  target: EnvTarget,
): EnvRefusal | undefined {
  if (state.env === env && sameOrganization(state.org.organizationId, target.organizationId)) {
    return undefined;
  }
  return {
    code: 'OTHER_ORG',
    message:
      `The state read for ${env} on ${target.alias} is of ${state.env} on ` +
      `${state.org.organizationId}: a state of another org is never applied. Nothing was ` +
      'read or written.',
    exit: 1,
  };
}

/**
 * What a verb meets with no state of the environment for the target: on a
 * Developer Edition org or a sandbox, a refusal unless `--accept-no-state` —
 * an earlier apply's records, if there were any, cannot be told from the
 * org's own, and would be created twice; on a scratch org, a warning. When
 * the journal directory still keeps runs of the environment on the org — the
 * state alone lost, or set aside — it says `state recover` rebuilds the state
 * from them.
 *
 * A sandbox whose state this machine kept under its former Organization Id,
 * on the same host, was refreshed since (`refreshed`, from
 * `EnvStore.refreshedOf`): what that state named went with the refresh, and
 * the apply starts anew without `--accept-no-state`, a flag that, put in a CI
 * job for the day after each refresh, would let through the day the cache is
 * lost with no refresh. Runs of the environment kept for the org's own Id
 * say an apply ran on it since, its state lost: the guard is today's then.
 */
export function noStateGuard(
  target: Pick<EnvTarget, 'alias' | 'kind' | 'organizationId' | 'host'>,
  env: string,
  acceptNoState: boolean,
  runsKept = false,
  refreshed?: EnvStateRefreshed,
): { refusal: EnvRefusal } | { warning: string; refreshed?: EnvPlanRefreshed } {
  if (
    refreshed !== undefined &&
    !runsKept &&
    refreshedSince({ ...refreshed, kind: 'sandbox' }, target)
  ) {
    const { organizationId, serial, updatedAt, setAside } = refreshed;
    const kept = { organizationId, serial, updatedAt, setAside };
    return { warning: refreshedStateWords(target.alias, kept), refreshed: kept };
  }
  const said =
    `this machine keeps no state of ${env} on ${target.alias}: records an earlier apply ` +
    'left there, from another machine or a cache that was not restored, cannot be told from ' +
    'the org’s own, and would be created twice' +
    (runsKept
      ? `; it keeps runs of ${env} on ${target.alias}, and ${commandOf('env')} state recover ` +
        'rebuilds the state from them'
      : '');
  if (target.kind === 'scratch' || acceptNoState) return { warning: said };
  return {
    refusal: {
      code: 'NO_STATE',
      message:
        `${said.charAt(0).toUpperCase()}${said.slice(1)}. On ${KIND_WORDS[target.kind]} ` +
        'that lives on, apply asks --accept-no-state to go ahead: restore the journal ' +
        'directory of the apply before it, or give the flag. Nothing was written.',
      exit: 1,
    },
  };
}

/**
 * What a plan says of the state of a sandbox refreshed since the last apply,
 * after `state: `: none under its Organization Id, the one kept under its
 * former Id, and where that one is kept, set aside — left as it was, never
 * deleted.
 */
export function refreshedStateWords(alias: string, refreshed: EnvPlanRefreshed): string {
  return (
    `none for this Organization Id; ${alias} was refreshed since the last apply, which this ` +
    `machine kept under ${refreshed.organizationId} (serial ${refreshed.serial}, ` +
    `${refreshed.updatedAt.slice(0, 10)}): the refresh took what it held, and this apply ` +
    `starts anew. That state is set aside, kept: ${refreshed.setAside}`
  );
}

/**
 * The store's refusal as the verb refuses it: the journal directory inside
 * the file's repository is a setup to change before anything runs (exit 2);
 * a folder another user owns, or one that cannot be made, is a refusal.
 */
export function storeRefusal(refusal: string, insideRepository: boolean): EnvRefusal {
  return insideRepository
    ? { code: 'STORE_IN_REPOSITORY', message: refusal, exit: 2 }
    : { code: 'STORE', message: refusal, exit: 1 };
}

/** Another apply, destroy or reset of the org under way on this machine, as a verb refuses it. */
export function lockRefusal(holder: EnvLockHolder): EnvRefusal {
  return { code: 'LOCKED', message: envLockRefusal(holder), exit: 1 };
}

/** A checkpoint take, rewind or undo of the org under way, as a step refuses to start. */
export function checkpointActRefusal(refusal: string): EnvRefusal {
  return {
    code: 'CHECKPOINT_ACT',
    message: `${refusal.charAt(0).toUpperCase()}${refusal.slice(1)}`,
    exit: 1,
  };
}
