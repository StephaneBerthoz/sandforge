/**
 * The refusal of a clone whose owner mapping gives records to users the
 * target refuses as owners: those it holds inactive (`OWNER_MAP_INACTIVE`),
 * and those it holds no user of (`OWNER_MAP_UNKNOWN`). A mapping is the
 * user's own choice of an owner, and the target refuses every record either
 * would own; the run never gives them to the user it writes as instead.
 *
 * Asked before anything else is read. The executor asks it as a run begins,
 * whoever calls it; the command line and the panel ask it before their own
 * reads of the target. Asked by the executor alone, a clone printed what the
 * target runs on the objects it writes, and then that nothing was read: the
 * executor's refusal now says that nothing was written, which is true of it.
 */

import { ForgeRunGateError, OWNER_MAP_INACTIVE, OWNER_MAP_UNKNOWN } from './ForgeRunGate.js';
import {
  mappedOwnersTheTargetRefuses,
  type MappedOwnerInactive,
  type MappedOwnerUnknown,
  type TargetRowsQuery,
} from './stages/TargetHolds.js';

/** The most users a refusal of the run's owner mapping names: the others are counted. */
const MAPPED_INACTIVE_NAMED = 10;

/** What each refusal ends on, asked before anything else is read: the run read and wrote nothing. */
const NOTHING_DONE = 'Nothing was read or written.';

/**
 * What the executor's ends on: by the time it asks again, discovery read the
 * source and its caller read the target's automation. Ended on
 * `NOTHING_DONE`, a run whose user was deactivated between the two asks said
 * that nothing was read, after it had printed what it read.
 */
export const NOTHING_WRITTEN = 'Nothing was written.';

/**
 * Why a run whose owner mapping gives records to users the target holds
 * inactive is refused before it reads anything: each user by name and id,
 * with the source owners mapped to it, at most ten, the others counted.
 */
export function ownerMapInactiveRefusal(
  inactive: readonly MappedOwnerInactive[],
  done: string = NOTHING_DONE,
): string {
  const said = inactive
    .slice(0, MAPPED_INACTIVE_NAMED)
    .map(
      ({ user, name, sources }) =>
        `${name !== undefined ? `${name} (${user})` : user}, given the records of ` +
        sources.join(', '),
    )
    .join('; ');
  const more = inactive.length - MAPPED_INACTIVE_NAMED;
  return (
    'Owners given to users the target holds inactive: ' +
    `${said}${more > 0 ? `; and ${more} more` : ''}. The target refuses a record owned by an ` +
    'inactive user, and the run will not give it to the user it writes as instead of the one ' +
    'chosen. Give those records to an active user under Owners (Review → Controls, or ' +
    '--owner-map on the command line), or reactivate the user in the target. ' +
    done
  );
}

/**
 * Why a run whose owner mapping gives records to users the target holds no
 * user of is refused before it reads anything: each id, with the source
 * owners mapped to it, at most ten, the others counted.
 */
export function ownerMapUnknownRefusal(
  unknown: readonly MappedOwnerUnknown[],
  done: string = NOTHING_DONE,
): string {
  const said = unknown
    .slice(0, MAPPED_INACTIVE_NAMED)
    .map(({ user, sources }) => `${user}, given the records of ${sources.join(', ')}`)
    .join('; ');
  const more = unknown.length - MAPPED_INACTIVE_NAMED;
  return (
    'Owners given to users the target does not hold: ' +
    `${said}${more > 0 ? `; and ${more} more` : ''}. The target refuses a record owned by a ` +
    'user it does not hold (INVALID_CROSS_REFERENCE_KEY), and the run will not give it to the ' +
    'user it writes as instead of the one chosen. Give those records to a user of the target ' +
    'under Owners (Review → Controls, or --owner-map on the command line). ' +
    done
  );
}

/**
 * The refusal of a run whose owner mapping gives records to users the target
 * refuses as owners, or none: asked of the target, `Id, Name, IsActive` of
 * each user mapped to, a simulation's as a run's. A user it lacks is said
 * under its own code, the inactive ones named after it; inactive ones alone,
 * under theirs. A read refused refuses nothing: the rows then go mapped, and
 * a refusal of one says so.
 */
export async function ownerMapRefusalOf(
  ownerMappings: Readonly<Record<string, string>>,
  query: TargetRowsQuery,
  done: string = NOTHING_DONE,
): Promise<ForgeRunGateError | undefined> {
  const { inactive, unknown } = await mappedOwnersTheTargetRefuses(ownerMappings, query);
  if (unknown.length > 0) {
    const lacking = ownerMapUnknownRefusal(unknown, done);
    return new ForgeRunGateError(
      OWNER_MAP_UNKNOWN,
      inactive.length > 0
        ? `${lacking.slice(0, -done.length)}${ownerMapInactiveRefusal(inactive, done)}`
        : lacking,
    );
  }
  return inactive.length > 0
    ? new ForgeRunGateError(OWNER_MAP_INACTIVE, ownerMapInactiveRefusal(inactive, done))
    : undefined;
}
