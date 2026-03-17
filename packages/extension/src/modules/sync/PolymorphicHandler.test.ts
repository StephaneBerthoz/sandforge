import { describe, it, expect, beforeEach } from 'vitest';
import { PolymorphicHandler } from './PolymorphicHandler';

describe('PolymorphicHandler', () => {
  let handler: PolymorphicHandler;

  beforeEach(() => {
    handler = new PolymorphicHandler();
  });

  describe('resolve', () => {
    it('should filter records matching the specified object type', () => {
      const records = [
        { Id: 'T1', WhoId: '003XXXXXXXXXXXX' },
        { Id: 'T2', WhoId: '00QXXXXXXXXXXXX' },
      ];

      const result = handler.resolve('WhoId', 'Contact', records);

      expect(result).toHaveLength(1);
      expect(result[0].Id).toBe('T1');
    });

    it('should add a type field with the resolved object type', () => {
      const records = [{ Id: 'T1', WhoId: '003XXXXXXXXXXXX' }];

      const result = handler.resolve('WhoId', 'Contact', records);

      expect(result[0].WhoIdType).toBe('Contact');
    });

    it('should resolve Account IDs with 001 prefix', () => {
      const records = [{ Id: 'T1', WhatId: '001XXXXXXXXXXXX' }];

      const result = handler.resolve('WhatId', 'Account', records);

      expect(result).toHaveLength(1);
      expect(result[0].WhatIdType).toBe('Account');
    });

    it('should resolve Lead IDs with 00Q prefix', () => {
      const records = [{ Id: 'T1', WhoId: '00QXXXXXXXXXXXX' }];

      const result = handler.resolve('WhoId', 'Lead', records);

      expect(result).toHaveLength(1);
    });

    it('should resolve User IDs with 005 prefix', () => {
      const records = [{ Id: 'T1', OwnerId: '005XXXXXXXXXXXX' }];

      const result = handler.resolve('OwnerId', 'User', records);

      expect(result).toHaveLength(1);
    });

    it('should exclude records with non-string field values', () => {
      const records = [
        { Id: 'T1', WhoId: null },
        { Id: 'T2', WhoId: 123 },
      ];

      const result = handler.resolve('WhoId', 'Contact', records);

      expect(result).toHaveLength(0);
    });

    it('should exclude records with IDs shorter than 3 characters', () => {
      const records = [{ Id: 'T1', WhoId: 'AB' }];

      const result = handler.resolve('WhoId', 'Contact', records);

      expect(result).toHaveLength(0);
    });

    it('should return empty array when no records match', () => {
      const records = [{ Id: 'T1', WhoId: '003XXXXXXXXXXXX' }];

      const result = handler.resolve('WhoId', 'Account', records);

      expect(result).toHaveLength(0);
    });

    it('should not modify the original records', () => {
      const records = [{ Id: 'T1', WhoId: '003XXXXXXXXXXXX' }];

      handler.resolve('WhoId', 'Contact', records);

      expect(records[0]).not.toHaveProperty('WhoIdType');
    });

    it('should handle empty records array', () => {
      const result = handler.resolve('WhoId', 'Contact', []);

      expect(result).toEqual([]);
    });

    it('should handle unknown ID prefixes', () => {
      const records = [{ Id: 'T1', WhoId: 'ZZZXXXXXXXXXXXX' }];

      const result = handler.resolve('WhoId', 'Unknown', records);

      expect(result).toHaveLength(1);
      expect(result[0].WhoIdType).toBe('Unknown');
    });

    it('should preserve all original record fields', () => {
      const records = [
        { Id: 'T1', Subject: 'Call', WhoId: '003XXXXXXXXXXXX', Priority: 'High' },
      ];

      const result = handler.resolve('WhoId', 'Contact', records);

      expect(result[0].Subject).toBe('Call');
      expect(result[0].Priority).toBe('High');
    });
  });

  describe('isPolymorphic', () => {
    it('should return true for WhoId', () => {
      expect(handler.isPolymorphic('WhoId')).toBe(true);
    });

    it('should return true for WhatId', () => {
      expect(handler.isPolymorphic('WhatId')).toBe(true);
    });

    it('should return true for OwnerId', () => {
      expect(handler.isPolymorphic('OwnerId')).toBe(true);
    });

    it('should return false for regular fields', () => {
      expect(handler.isPolymorphic('Name')).toBe(false);
      expect(handler.isPolymorphic('AccountId')).toBe(false);
    });
  });
});
