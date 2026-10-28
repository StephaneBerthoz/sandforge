/**
 * The lock that keeps two applies, destroys or resets of one org apart on this
 * machine.
 *
 * One file per Organization Id, `<organizationId>.env.lock`, in the folder of
 * the checkpoint locks (`~/.sandforge/locks`, whatever `SANDFORGE_JOURNAL_DIR`
 * says: one place per user of the machine), on the checkpoint store's
 * link-file mechanism. It is a file of its own, not the checkpoint lock: a
 * lock file names the process that holds it, and refuses any other process
 * while that one is alive — the `checkpoint take` an apply spawns is another
 * process, and would be refused by its own parent's lock.
 *
 * Two machines applying to one org at once are not kept apart: nothing
 * SandForge could hold without writing to the org does it. The jobs are given
 * one concurrency group of their CI instead.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import * as z from 'zod';
import { envNameSchema } from '@sandforge/shared';
import {
  linkedLockKind,
  lockHolderShape,
  type LinkedLockOptions,
} from '../../src/modules/checkpoint/linkedLock.js';
import {
  defaultCheckpointLocksDir,
  orgLockHolder,
  organizationKey,
  type OrgLockHolder,
} from '../../src/modules/checkpoint/OrgCheckpointStore.js';

/** What holds an org's environment lock: a state recover too, which writes the state an apply reads. */
export type EnvLockOperation = 'apply' | 'destroy' | 'reset' | 'recover';

/** An environment lock file, as it is written and read back. */
const envLockFileSchema = z.object({
  ...lockHolderShape,
  operation: z.enum(['apply', 'destroy', 'reset', 'recover']),
  /** The environment's name, as its file gives it. */
  env: envNameSchema,
  /** The alias the org was named by on this machine. */
  alias: z.string().min(1).max(255).optional(),
});

type EnvLockFile = z.infer<typeof envLockFileSchema>;

/** Who holds an org's environment lock, as a refusal names it. */
export type EnvLockHolder = Omit<EnvLockFile, 'version' | 'token'>;

/** An org's environment lock, held until it is released. */
export interface EnvLock {
  readonly organizationId: string;
  /** Let the lock go; once is enough, and again does nothing. */
  release(): void;
}

const ENV_LOCKS = linkedLockKind((content) => {
  const parsed = envLockFileSchema.safeParse(content);
  return parsed.success ? parsed.data : undefined;
});

/** Where the environment locks are: beside the checkpoint locks, one place per user of the machine. */
export function defaultEnvLocksDir(home: string = homedir()): string {
  return defaultCheckpointLocksDir(home);
}

/**
 * Where an org's environment lock is: named by its 18-character Organization
 * Id, whichever form it is given in, so the two forms of one org are one lock.
 */
export function envLockFileOf(locksDir: string, organizationId: string): string {
  return join(locksDir, `${organizationKey(organizationId)}.env.lock`);
}

/**
 * Take the environment lock of an org, for an apply, a destroy or a reset of
 * one environment. One whose holder is alive is said, and nothing is taken;
 * one whose holder is gone is taken over.
 */
export function acquireEnvLock(
  locksDir: string,
  organizationId: string,
  request: { operation: EnvLockOperation; env: string; alias?: string },
  options: LinkedLockOptions = {},
): { lock: EnvLock } | { busy: EnvLockHolder } {
  const file = envLockFileOf(locksDir, organizationId);
  const env = envNameSchema.parse(request.env);
  const outcome = ENV_LOCKS.acquire(
    file,
    (head) => ({
      ...head,
      operation: request.operation,
      env,
      ...(request.alias !== undefined ? { alias: request.alias } : {}),
    }),
    options,
  );
  if ('busy' in outcome) return { busy: holderOf(outcome.busy) };
  return {
    lock: { organizationId: organizationKey(organizationId), release: outcome.lock.release },
  };
}

/** Who holds an org's environment lock, alive; undefined when nobody does. */
export function envLockHolder(
  locksDir: string,
  organizationId: string,
  options: LinkedLockOptions = {},
): EnvLockHolder | undefined {
  const holder = ENV_LOCKS.holder(envLockFileOf(locksDir, organizationId), options);
  return holder !== undefined ? holderOf(holder) : undefined;
}

function holderOf({ version: _version, token: _token, ...holder }: EnvLockFile): EnvLockHolder {
  return holder;
}

/** The process that holds a lock, as a line names it. */
function processOf(holder: { host: string; pid: number; acquiredAt: string }): string {
  return `process ${holder.pid} on ${holder.host}, since ${holder.acquiredAt}`;
}

/**
 * What an apply, a destroy or a reset says when another one of the org holds
 * its lock: who, since when, and to wait for it.
 */
export function envLockRefusal(holder: EnvLockHolder): string {
  return (
    `${envLockLine(holder)}. Nothing was written: run this again once it ends. Two jobs ` +
    'applying to one org from two machines are not kept apart: give them one concurrency group.'
  );
}

/** What a plan says of an apply under way: the plan may be out of date when it ends. */
export function envLockLine(holder: EnvLockHolder): string {
  const org = holder.alias !== undefined ? ` to ${holder.alias}` : '';
  const what =
    holder.operation === 'apply'
      ? 'an apply'
      : holder.operation === 'recover'
        ? 'a state recover'
        : `a ${holder.operation}`;
  return `${what} of ${holder.env}${org} is under way on this machine (${processOf(holder)})`;
}

/**
 * Why a step may not start now: a take, a rewind or an undo of the org's
 * checkpoints runs, and a step's records written meanwhile would be part of
 * what it takes or puts back. Undefined when none runs.
 */
export function checkpointLockRefusal(
  locksDir: string,
  organizationId: string,
  options: LinkedLockOptions = {},
): string | undefined {
  const holder: OrgLockHolder | undefined = orgLockHolder(locksDir, organizationId, options);
  if (holder === undefined) return undefined;
  return (
    `a checkpoint ${holder.operation} of this org is under way on this machine ` +
    `(${processOf(holder)}): its records would be read or written as the step writes. ` +
    'Run this again once it ends.'
  );
}
