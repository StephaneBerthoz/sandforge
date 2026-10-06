/**
 * An org's active users, as Review lists them to map the owner of the rows a
 * run writes to one of the target's: by name, each with its id kept, and the
 * username that tells two users of the same name apart.
 */

import type { ForgeOrgUser } from '@sandforge/shared';

/** The most users the list carries: past it, it says it was cut. */
export const USERS_LISTED = 2_000;

/**
 * The active users who can own a record: a standard user holds a licence that
 * owns records, where a guest, an automated process or a Chatter Free user
 * does not, and an owner mapped to one is refused at the write. One more than
 * the list carries is asked for, to tell a full list from a cut one.
 */
export const ACTIVE_USERS_SOQL =
  "SELECT Id, Name, Username FROM User WHERE IsActive = true AND UserType = 'Standard' " +
  `ORDER BY Name LIMIT ${USERS_LISTED + 1}`;

/** The users an answer to {@link ACTIVE_USERS_SOQL} holds, and whether the list was cut. */
export function activeUsersOf(
  rows: readonly Record<string, unknown>[],
  more: boolean,
): { users: ForgeOrgUser[]; truncated: boolean } {
  const users = rows.flatMap((row): ForgeOrgUser[] => {
    const { Id: id, Name: name, Username: username } = row;
    if (typeof id !== 'string' || typeof name !== 'string') return [];
    return [{ id, name, username: typeof username === 'string' ? username : '' }];
  });
  return {
    users: users.slice(0, USERS_LISTED),
    truncated: more || users.length > USERS_LISTED,
  };
}
