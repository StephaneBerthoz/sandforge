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
 * - **a sandbox the file does not list by its Organization Id**
 *   (`targets.sandboxes`): nothing Salesforce says tells a full copy holding
 *   a client's records from a developer's sandbox, and the command lines
 *   never see Org Manager's Staging mark. A refresh changes the Id, so a
 *   sandbox refreshed from production is refused until someone lists it
 *   again;
 * - **a protected org** (`targets.protect`), whatever else says;
 * - **a state filed under another org**, or one that does not read: a destroy
 *   would take back records of an org it does not describe;
 * - **no state on a Developer Edition org or a sandbox** without
 *   `--accept-no-state`: an earlier apply's records cannot be told from the
 *   org's own, and would be created twice. A scratch org usually lives as long
 *   as the job that applies to it: it is warned of, not refused;
 * - **the journal directory inside the file's repository**, where the state
 *   and the run summaries would be committed;
 * - **another apply, destroy or reset of the org, or a checkpoint act**, under
 *   way on this machine.
 *
 * A scratch org says `IsSandbox` true, as a sandbox does: only the `sf` CLI
 * tells them apart, by the Dev Hub its display names. An org the CLI does not
 * show as a scratch org is a sandbox here, and refused unless listed — the
 * safe side of a question the org itself cannot answer.
 */

import type { EnvState, EnvTargetKind, EnvTargets } from '@sandforge/shared';
import { isProductionTarget, type TypedTarget } from '../../src/core/precheck/orgKindLive.js';
import { organizationKey } from '../../src/modules/checkpoint/OrgCheckpointStore.js';
import type { EnvStateError } from './envState.js';
import { envLockRefusal, type EnvLockHolder } from './envLock.js';

/** What refused, in a word a pipeline reads. */
export type EnvRefusalCode =
  | 'PRODUCTION'
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
  | 'NO_CHECKPOINT';

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
 * @param typed - What the org's Organization record said, or why it said nothing.
 * @param session - Whether the `sf` CLI shows it as a scratch org, and its user.
 */
export function envTargetOf(
  alias: string,
  typed: TypedTarget | { unread: string },
  session: { scratch?: true; username: string },
): { target: EnvTarget } | { refusal: EnvRefusal } {
  if ('unread' in typed) {
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
  return {
    target: { alias, organizationId: typed.id, kind, username: session.username },
  };
}

/** A kind of org as a refusal says it. */
const KIND_WORDS: Readonly<Record<EnvTargetKind, string>> = {
  scratch: 'a scratch org',
  developer: 'a Developer Edition org',
  sandbox: 'a sandbox',
};

/**
 * Why the file may not be applied to the target, or nothing when it may: a
 * protected org, a kind of org the file does not allow, or a sandbox it does
 * not list by its Organization Id. Compared on the 15 characters both forms
 * of an Id share.
 */
export function targetRefusal(targets: EnvTargets, target: EnvTarget): EnvRefusal | undefined {
  const id = target.organizationId;
  if (targets.protect.some((protectedId) => sameOrganization(protectedId, id))) {
    return {
      code: 'PROTECTED',
      message:
        `${target.alias} (${organizationKey(id)}) is listed under targets.protect: the file ` +
        'refuses it whatever else it says. Nothing was read or written.',
      exit: 1,
    };
  }
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
  if (
    target.kind === 'sandbox' &&
    !targets.sandboxes.some((listed) => sameOrganization(listed, id))
  ) {
    return {
      code: 'NOT_LISTED',
      message:
        `${target.alias} is a sandbox, and its Organization Id ${organizationKey(id)} is not ` +
        'listed under targets.sandboxes: nothing Salesforce says tells a sandbox that holds ' +
        "a client's records from a developer's, so each one the file writes to is listed, " +
        'reviewed with the file. A refresh changes the Id: a sandbox listed before its ' +
        'refresh is listed again. Nothing was read or written. If it is a scratch org, the sf ' +
        'CLI did not say so: its display names no Dev Hub for it, as when the org was logged ' +
        'in with an auth URL alone.',
      exit: 1,
    };
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
 * org's own, and would be created twice; on a scratch org, a warning.
 */
export function noStateGuard(
  target: Pick<EnvTarget, 'alias' | 'kind'>,
  env: string,
  acceptNoState: boolean,
): { refusal: EnvRefusal } | { warning: string } {
  const said =
    `this machine keeps no state of ${env} on ${target.alias}: records an earlier apply ` +
    'left there, from another machine or a cache that was not restored, cannot be told from ' +
    'the org’s own, and would be created twice';
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
