/** User information from a Salesforce org */
export interface UserInfo {
  id: string;
  username: string;
  email: string;
}

/** Mapping between source and target user IDs */
export interface UserMapping {
  sourceId: string;
  targetId: string;
  username: string;
}

/**
 * Maps user references between Salesforce orgs.
 * User IDs differ between orgs, so fields like OwnerId, CreatedById, etc.
 * must be remapped. Matching is done by username.
 */
export class UserMapper {
  /**
   * Build a mapping between source and target users.
   * Matches users by username, which is typically consistent across orgs.
   */
  buildMapping(sourceUsers: UserInfo[], targetUsers: UserInfo[]): UserMapping[] {
    const targetByUsername = new Map<string, UserInfo>();
    for (const user of targetUsers) {
      targetByUsername.set(user.username, user);
    }

    const mappings: UserMapping[] = [];

    for (const sourceUser of sourceUsers) {
      const targetUser = targetByUsername.get(sourceUser.username);
      if (targetUser) {
        mappings.push({
          sourceId: sourceUser.id,
          targetId: targetUser.id,
          username: sourceUser.username,
        });
      }
    }

    return mappings;
  }

  /**
   * Apply user mappings to a set of records.
   * Replaces source user IDs with target user IDs in the specified fields.
   */
  apply(
    records: Record<string, unknown>[],
    userFields: string[],
    mappings: UserMapping[],
  ): Record<string, unknown>[] {
    const mappingBySourceId = new Map<string, string>();
    for (const m of mappings) {
      mappingBySourceId.set(m.sourceId, m.targetId);
    }

    return records.map((record) => {
      const mapped = { ...record };

      for (const field of userFields) {
        const value = mapped[field];
        if (typeof value !== 'string') {
          continue;
        }

        const targetId = mappingBySourceId.get(value);
        if (targetId) {
          mapped[field] = targetId;
        }
      }

      return mapped;
    });
  }
}
