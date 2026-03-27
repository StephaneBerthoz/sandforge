import { describe, it, expect } from 'vitest';
import { ConflictDiffService } from './ConflictDiffService';

describe('ConflictDiffService', () => {
  describe('diffFields', () => {
    it('should return empty array for identical records', () => {
      const record = { Name: 'Acme', Industry: 'Tech' };
      const result = ConflictDiffService.diffFields(record, { ...record });

      expect(result).toEqual([]);
    });

    it('should detect changed, added, and removed fields', () => {
      const source = { Name: 'Acme', Industry: 'Tech' };
      const target = { Name: 'Globex', Phone: '555-0100' };

      const result = ConflictDiffService.diffFields(source, target);

      const nameField = result.find((d) => d.field === 'Name');
      expect(nameField).toBeDefined();
      expect(nameField?.sourceValue).toBe('Acme');
      expect(nameField?.targetValue).toBe('Globex');
      expect(nameField?.type).toBe('changed');

      const industryField = result.find((d) => d.field === 'Industry');
      expect(industryField).toBeDefined();
      expect(industryField?.type).toBe('removed');

      const phoneField = result.find((d) => d.field === 'Phone');
      expect(phoneField).toBeDefined();
      expect(phoneField?.type).toBe('added');
    });

    it('should handle null and undefined values correctly', () => {
      const source = { Name: null, Industry: undefined };
      const target = { Name: 'Acme', Industry: 'Tech' };

      const result = ConflictDiffService.diffFields(
        source as Record<string, unknown>,
        target,
      );

      expect(result.length).toBeGreaterThanOrEqual(1);
      const nameField = result.find((d) => d.field === 'Name');
      expect(nameField).toBeDefined();
      expect(nameField?.sourceValue).toBeNull();
      expect(nameField?.targetValue).toBe('Acme');
    });
  });

  describe('diffThreeWay', () => {
    it('should auto-resolve non-overlapping changes', () => {
      const base = { Name: 'Acme', Industry: 'Tech', Phone: '111' };
      const source = { Name: 'Acme Corp', Industry: 'Tech', Phone: '111' };
      const target = { Name: 'Acme', Industry: 'Finance', Phone: '111' };

      const result = ConflictDiffService.diffThreeWay(base, source, target);

      expect(result.autoResolved).toEqual({
        Name: 'Acme Corp',
        Industry: 'Finance',
      });
      expect(result.conflicts).toEqual([]);
    });

    it('should produce conflicts with baseValue for overlapping changes', () => {
      const base = { Name: 'Acme', Industry: 'Tech' };
      const source = { Name: 'Source Name', Industry: 'Tech' };
      const target = { Name: 'Target Name', Industry: 'Tech' };

      const result = ConflictDiffService.diffThreeWay(base, source, target);

      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0].field).toBe('Name');
      expect(result.conflicts[0].sourceValue).toBe('Source Name');
      expect(result.conflicts[0].targetValue).toBe('Target Name');
      expect(result.conflicts[0].baseValue).toBe('Acme');
    });

    it('should auto-resolve field changed only in source to source value', () => {
      const base = { Name: 'Acme', Phone: '111' };
      const source = { Name: 'New Acme', Phone: '111' };
      const target = { Name: 'Acme', Phone: '111' };

      const result = ConflictDiffService.diffThreeWay(base, source, target);

      expect(result.autoResolved).toEqual({ Name: 'New Acme' });
      expect(result.conflicts).toEqual([]);
    });

    it('should auto-resolve when both sides make the same change', () => {
      const base = { Name: 'Acme' };
      const source = { Name: 'Same Name' };
      const target = { Name: 'Same Name' };

      const result = ConflictDiffService.diffThreeWay(base, source, target);

      expect(result.autoResolved).toEqual({ Name: 'Same Name' });
      expect(result.conflicts).toEqual([]);
    });

    it('should handle mixed auto-resolved and conflicting fields', () => {
      const base = { Name: 'Acme', Industry: 'Tech', Phone: '111' };
      const source = { Name: 'Source', Industry: 'Finance', Phone: '111' };
      const target = { Name: 'Target', Industry: 'Tech', Phone: '222' };

      const result = ConflictDiffService.diffThreeWay(base, source, target);

      expect(result.autoResolved.Industry).toBe('Finance');
      expect(result.autoResolved.Phone).toBe('222');
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0].field).toBe('Name');
    });
  });
});
