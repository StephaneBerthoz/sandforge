import { describe, expect, it } from 'vitest';
import { ACTIVE_USERS_SOQL, USERS_LISTED, activeUsersOf } from './orgUsers.js';

describe('activeUsersOf', () => {
  it('lists each user by name with its id and username, and skips a row that names none', () => {
    expect(
      activeUsersOf(
        [
          { Id: '005000000000001AAA', Name: 'Ada Admin', Username: 'ada@example.invalid' },
          { Id: '005000000000002AAA', Name: 'Bo Builder' },
          { Id: '005000000000003AAA' },
        ],
        false,
      ),
    ).toEqual({
      users: [
        { id: '005000000000001AAA', name: 'Ada Admin', username: 'ada@example.invalid' },
        { id: '005000000000002AAA', name: 'Bo Builder', username: '' },
      ],
      truncated: false,
    });
  });

  it('says the list was cut when the org holds more users than it carries', () => {
    const rows = Array.from({ length: USERS_LISTED + 1 }, (_, i) => ({
      Id: `005${String(i).padStart(12, '0')}AAA`,
      Name: `User ${i}`,
    }));

    const listed = activeUsersOf(rows, false);

    expect(listed.users).toHaveLength(USERS_LISTED);
    expect(listed.truncated).toBe(true);
    expect(activeUsersOf(rows.slice(0, 3), true).truncated).toBe(true);
  });

  it('asks for the active users who can own a record, by name, one past the list', () => {
    expect(ACTIVE_USERS_SOQL).toBe(
      "SELECT Id, Name, Username FROM User WHERE IsActive = true AND UserType = 'Standard' " +
        'ORDER BY Name LIMIT 2001',
    );
  });
});
