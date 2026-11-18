/**
 * The users of a sandbox brought back from the Back into service page, on
 * the same core and the same store as `sandforge users`
 * (`modules/users/`), so that a run the page made is one the command line
 * lists, replaces and removes, and the other way round.
 *
 * - **The list** read in the sandbox (`usersToRestoreOf`) is told the page
 *   as the contract names it: an address under `.invalid` whose change a run
 *   of this org asked is awaiting its owner's click, never restored; one
 *   without `.invalid` is restored. Never the address itself, nor the
 *   person's name.
 * - **The testers** a person keeps for the sandbox are filed by its My
 *   Domain host, which a refresh keeps (`orgHost.ts`), else by its entry.
 * - **A run follows its simulation**: the plan answered for the same choices
 *   is compared with the plan read again before the first write, and a run
 *   whose org changed between the two is refused before it writes.
 * - **Its progress** is read off the run file the run writes after each of
 *   its steps: the users whose every change the org took or refused.
 */

import * as z from 'zod';
import {
  usernameKey,
  usersConfigSchema,
  type AuditObjectCounts,
  type RecoveryUser,
  type RecoveryUsersRunPayload,
  type UsersApplyAnswer,
  type UsersChange,
  type UsersConfig,
  type UsersPlanAnswer,
} from '@sandforge/shared';
import type { ConfigStore } from '../../core/storage/ConfigStore.js';
import type { UserToRestore } from '../users/usersGates.js';
import type { UsersRefusal } from '../users/usersPlan.js';
import {
  UsersRunStore,
  type UsersRunRecord,
  type UsersRunStoreOptions,
} from '../users/usersRunStore.js';

// ─── The list ────────────────────────────────────────────────────────────────

/**
 * The users whose address a run of the org asked back, by username: as the
 * newest run that holds each says it, awaiting its owner's click.
 *
 * @param records - The org's runs, newest first.
 */
export function awaitingAddressesOf(records: readonly UsersRunRecord[]): Set<string> {
  const seen = new Set<string>();
  const awaiting = new Set<string>();
  for (const record of records) {
    for (const user of record.users) {
      const key = usernameKey(user.applied.username);
      if (seen.has(key)) continue;
      seen.add(key);
      if (user.applied.address === 'awaiting') awaiting.add(key);
    }
  }
  return awaiting;
}

/** The users read in the sandbox, as the page lists them. */
export function recoveryUsersOf(
  listed: readonly UserToRestore[],
  awaiting: ReadonlySet<string>,
): RecoveryUser[] {
  return listed.map((user) => ({
    username: user.username,
    userId: user.userId,
    address:
      user.address === 'valid'
        ? 'restored'
        : awaiting.has(usernameKey(user.username))
          ? 'awaiting'
          : 'invalid',
    active: user.active,
    frozen: user.frozen,
    ...(user.profile !== undefined ? { profile: user.profile } : {}),
  }));
}

// ─── The testers kept ────────────────────────────────────────────────────────

/** The category the page's records of a sandbox are kept under in the extension's store. */
export const RECOVERY_CATEGORY = 'recovery';

/**
 * Where the testers of a sandbox are kept: its My Domain host, which a
 * refresh keeps and an entry imported again shares; else its entry.
 */
export function recoveryTestersKey(host: string | undefined, entryId: string): string {
  return host !== undefined ? `recoveryTesters:host:${host}` : `recoveryTesters:entry:${entryId}`;
}

/** The testers kept, as `users.json` holds them, and when. */
export const savedTestersSchema = z.strictObject({
  config: usersConfigSchema,
  savedAt: z.iso.datetime({ offset: true }),
});

export type SavedTesters = z.infer<typeof savedTestersSchema>;

/** The testers kept under `key`; none when nothing that reads is kept there. */
export function readSavedTesters(
  configStore: Pick<ConfigStore, 'get'>,
  key: string,
): SavedTesters | undefined {
  const parsed = savedTestersSchema.safeParse(configStore.get<unknown>(key));
  return parsed.success ? parsed.data : undefined;
}

/** Keep the testers under `key`, and say when. */
export function saveTesters(
  configStore: Pick<ConfigStore, 'set'>,
  key: string,
  config: UsersConfig,
  now: Date,
): SavedTesters {
  const saved = { config, savedAt: now.toISOString() };
  configStore.set(key, saved, RECOVERY_CATEGORY);
  return saved;
}

// ─── A run ───────────────────────────────────────────────────────────────────

/** The code a run is refused with when the run it replaces is not kept for the org. */
export const USERS_RUN_NOT_FOUND = 'USERS_RUN_NOT_FOUND';

/** The code a run is refused with when the run it replaces was replaced already. */
export const USERS_RUN_REPLACED = 'USERS_RUN_REPLACED';

/**
 * The run a page's run replaces, from the store the command line keeps them
 * in, or why it cannot be replaced: as `sandforge users --replaces` reads it.
 */
export async function replacedRunOf(
  store: Pick<UsersRunStore, 'read' | 'list'>,
  organizationId: string,
  run: number,
): Promise<{ record: UsersRunRecord } | { refusal: UsersRefusal }> {
  const record = await store.read(organizationId, run);
  if (!record) {
    return {
      refusal: {
        code: USERS_RUN_NOT_FOUND,
        message:
          `Run ${run} is not kept on this machine for this org, whose Organization Id is ` +
          `${organizationId}: a sandbox refreshed since answers another, and its runs went with ` +
          'the copy they set up. Simulate without it to set the users up anew.',
      },
    };
  }
  const replacing = (await store.list(organizationId)).find((each) => each.replaces === run);
  if (replacing) {
    return {
      refusal: {
        code: USERS_RUN_REPLACED,
        message:
          `Run ${run} was replaced by run ${replacing.run}, which holds what it set up: ` +
          `simulate again, replacing run ${replacing.run}.`,
      },
    };
  }
  return { record };
}

/**
 * What a run of the page is asked with, as one key: the users and their
 * defaults, the run replaced, and the acceptances. A simulation answers for
 * these choices alone.
 */
export function choicesKeyOf(payload: RecoveryUsersRunPayload): string {
  return JSON.stringify([
    payload.orgId,
    payload.config,
    payload.replaces ?? null,
    payload.acceptUserEmails,
    payload.acceptEmails,
    payload.acceptAutomation,
  ]);
}

/**
 * What a plan says a run would do, without what it cost to read: two plans of
 * the same choices that say the same are the same run. The users, each with
 * its changes, its address and the emails it is sent; the licenses taken;
 * the refusals by their code.
 */
export function planSignatureOf(answer: UsersPlanAnswer): string {
  return JSON.stringify({
    org: answer.org.organizationId,
    users: answer.users.map((user) => [
      user.username,
      user.userId ?? null,
      user.address ?? null,
      user.changes,
      user.emailsToPeople ?? 0,
    ]),
    licenses: (answer.licenses ?? []).map((license) => [license.name, license.toUse]),
    emailsToPeople: answer.emailsToPeople,
    refusals: (answer.refusals ?? []).map((refusal) => [refusal.code, refusal.username ?? null]),
  });
}

/** The users a run changes: those of its plan with a change. */
export function changingUsersOf(plan: UsersPlanAnswer): number {
  return plan.users.filter((user) => user.changes.length > 0).length;
}

/**
 * The users of a run whose every change the org took or refused, as the run
 * file written after a step holds them.
 */
export function usersDoneOf(record: UsersRunRecord, plan: UsersPlanAnswer): number {
  const changes = new Map(
    plan.users
      .filter((user) => user.changes.length > 0)
      .map((user) => [usernameKey(user.username), user.changes.length]),
  );
  let done = 0;
  for (const user of record.users) {
    const planned = changes.get(usernameKey(user.applied.username));
    if (planned === undefined) continue;
    const met = user.applied.done.length + (user.applied.refused?.length ?? 0);
    if (met >= planned) done += 1;
  }
  return done;
}

/** The object a change writes: a user's row, its login's, an assignment or a membership. */
function objectOfChange(change: UsersChange): string {
  if (change.what === 'frozen') return 'UserLogin';
  if (change.what === 'group') return 'GroupMember';
  if (change.what === 'permissionSet' || change.what === 'permissionSetGroup') {
    return 'PermissionSetAssignment';
  }
  return 'User';
}

/**
 * What a run did per object, as the audit trail records it: the users and
 * logins it updated, the assignments and memberships it created and took
 * back, and what the org refused. Counts alone, never a username.
 */
export function usersAuditObjectsOf(applied: UsersApplyAnswer): AuditObjectCounts[] {
  const counts = new Map<string, AuditObjectCounts>(
    ['User', 'UserLogin', 'PermissionSetAssignment', 'GroupMember'].map((objectApiName) => [
      objectApiName,
      { objectApiName, created: 0, updated: 0, deleted: 0, failed: 0 },
    ]),
  );
  const of = (objectApiName: string): AuditObjectCounts =>
    counts.get(objectApiName) as AuditObjectCounts;
  for (const user of applied.users) {
    const updated = new Set(
      user.done.filter((change) => !('name' in change)).map((change) => objectOfChange(change)),
    );
    for (const objectApiName of updated) of(objectApiName).updated += 1;
    of('PermissionSetAssignment').created += user.created.permissionSetAssignments.length;
    of('GroupMember').created += user.created.groupMembers.length;
    for (const change of user.done) {
      if ('name' in change && change.to === 'removed') of(objectOfChange(change)).deleted += 1;
    }
    for (const refused of user.refused ?? []) of(objectOfChange(refused.change)).failed += 1;
  }
  return [...counts.values()].filter(
    (one) => one.created + one.updated + one.deleted + one.failed > 0,
  );
}

/**
 * The runs' store, told of each run file it writes: what a run under way
 * writes after each of its steps, which the page's progress is read from.
 */
export class ObservedUsersRunStore extends UsersRunStore {
  constructor(
    options: UsersRunStoreOptions,
    private readonly onWrite: (record: UsersRunRecord) => void,
  ) {
    super(options);
  }

  override async write(record: UsersRunRecord): Promise<void> {
    await super.write(record);
    this.onWrite(record);
  }
}
