import { describe, it, expect, beforeEach } from 'vitest';
import { UserMapper } from './UserMapper';
import type { UserInfo, UserMapping } from './UserMapper';

function createUser(overrides?: Partial<UserInfo>): UserInfo {
  return {
    id: '005000000000001',
    username: 'admin@example.com',
    email: 'admin@example.com',
    ...overrides,
  };
}

describe('UserMapper', () => {
  let mapper: UserMapper;

  beforeEach(() => {
    mapper = new UserMapper();
  });

  describe('buildMapping', () => {
    it('should map users by username', () => {
      const source = [createUser({ id: 'src-user-1', username: 'admin@source.com' })];
      const target = [createUser({ id: 'tgt-user-1', username: 'admin@source.com' })];

      const mappings = mapper.buildMapping(source, target);

      expect(mappings).toHaveLength(1);
      expect(mappings[0]).toEqual({
        sourceId: 'src-user-1',
        targetId: 'tgt-user-1',
        username: 'admin@source.com',
      });
    });

    it('should only include users present in both orgs', () => {
      const source = [
        createUser({ id: 'src-1', username: 'shared@test.com' }),
        createUser({ id: 'src-2', username: 'source-only@test.com' }),
      ];
      const target = [
        createUser({ id: 'tgt-1', username: 'shared@test.com' }),
        createUser({ id: 'tgt-2', username: 'target-only@test.com' }),
      ];

      const mappings = mapper.buildMapping(source, target);

      expect(mappings).toHaveLength(1);
      expect(mappings[0].username).toBe('shared@test.com');
    });

    it('should return empty array when no common users', () => {
      const source = [createUser({ username: 'a@test.com' })];
      const target = [createUser({ username: 'b@test.com' })];

      expect(mapper.buildMapping(source, target)).toEqual([]);
    });

    it('should handle empty source list', () => {
      expect(mapper.buildMapping([], [createUser()])).toEqual([]);
    });

    it('should handle empty target list', () => {
      expect(mapper.buildMapping([createUser()], [])).toEqual([]);
    });

    it('should handle multiple matching users', () => {
      const source = [
        createUser({ id: 'src-1', username: 'admin@test.com' }),
        createUser({ id: 'src-2', username: 'user@test.com' }),
      ];
      const target = [
        createUser({ id: 'tgt-1', username: 'admin@test.com' }),
        createUser({ id: 'tgt-2', username: 'user@test.com' }),
      ];

      const mappings = mapper.buildMapping(source, target);

      expect(mappings).toHaveLength(2);
    });
  });

  describe('apply', () => {
    it('should replace user field with target ID', () => {
      const records = [{ Name: 'Acme', OwnerId: 'src-user-1' }];
      const mappings: UserMapping[] = [
        { sourceId: 'src-user-1', targetId: 'tgt-user-1', username: 'admin@test.com' },
      ];

      const result = mapper.apply(records, ['OwnerId'], mappings);

      expect(result[0].OwnerId).toBe('tgt-user-1');
    });

    it('should handle multiple user fields', () => {
      const records = [
        { Name: 'Acme', OwnerId: 'src-1', CreatedById: 'src-2' },
      ];
      const mappings: UserMapping[] = [
        { sourceId: 'src-1', targetId: 'tgt-1', username: 'admin@test.com' },
        { sourceId: 'src-2', targetId: 'tgt-2', username: 'user@test.com' },
      ];

      const result = mapper.apply(records, ['OwnerId', 'CreatedById'], mappings);

      expect(result[0].OwnerId).toBe('tgt-1');
      expect(result[0].CreatedById).toBe('tgt-2');
    });

    it('should leave unmapped user IDs unchanged', () => {
      const records = [{ Name: 'Acme', OwnerId: 'unknown-user' }];

      const result = mapper.apply(records, ['OwnerId'], []);

      expect(result[0].OwnerId).toBe('unknown-user');
    });

    it('should skip non-string user field values', () => {
      const records = [{ Name: 'Acme', OwnerId: null }];
      const mappings: UserMapping[] = [
        { sourceId: 'src-1', targetId: 'tgt-1', username: 'admin@test.com' },
      ];

      const result = mapper.apply(records, ['OwnerId'], mappings);

      expect(result[0].OwnerId).toBeNull();
    });

    it('should not modify original records', () => {
      const records = [{ Name: 'Acme', OwnerId: 'src-1' }];
      const mappings: UserMapping[] = [
        { sourceId: 'src-1', targetId: 'tgt-1', username: 'admin@test.com' },
      ];

      mapper.apply(records, ['OwnerId'], mappings);

      expect(records[0].OwnerId).toBe('src-1');
    });

    it('should handle empty records array', () => {
      expect(mapper.apply([], ['OwnerId'], [])).toEqual([]);
    });

    it('should handle empty userFields array', () => {
      const records = [{ Name: 'Acme', OwnerId: 'src-1' }];
      const mappings: UserMapping[] = [
        { sourceId: 'src-1', targetId: 'tgt-1', username: 'admin@test.com' },
      ];

      const result = mapper.apply(records, [], mappings);

      expect(result[0].OwnerId).toBe('src-1');
    });

    it('should preserve non-user fields', () => {
      const records = [{ Name: 'Acme', Industry: 'Tech', OwnerId: 'src-1' }];
      const mappings: UserMapping[] = [
        { sourceId: 'src-1', targetId: 'tgt-1', username: 'admin@test.com' },
      ];

      const result = mapper.apply(records, ['OwnerId'], mappings);

      expect(result[0].Name).toBe('Acme');
      expect(result[0].Industry).toBe('Tech');
    });
  });
});
