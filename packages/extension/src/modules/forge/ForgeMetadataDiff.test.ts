import { describe, it, expect } from 'vitest';
import { ForgeMetadataDiff } from './ForgeMetadataDiff.js';
import type { MetadataDiffDeps, DescribedField } from './ForgeMetadataDiff.js';

function makeDeps(schemas: Record<string, Record<string, DescribedField[]>>): MetadataDiffDeps {
  return {
    describeObject: async (orgId: string, objectApiName: string) => {
      const orgSchemas = schemas[orgId];
      const fields = orgSchemas?.[objectApiName] ?? [];
      return { fields };
    },
  };
}

describe('ForgeMetadataDiff', () => {
  describe('compare', () => {
    it('should return empty diffs for identical schemas', async () => {
      const fields: DescribedField[] = [
        { name: 'Name', type: 'string', createable: true },
        { name: 'Email', type: 'email', createable: true },
      ];
      const deps = makeDeps({
        source: { Account: fields },
        target: { Account: fields },
      });
      const diff = new ForgeMetadataDiff(deps);

      const result = await diff.compare('source', 'target', ['Account']);
      expect(result).toEqual([]);
    });

    // Run for real, the target's NOT_FOUND on one object of the graph failed
    // the whole comparison, and the Review tab showed nothing else.
    it('names an object the target lacks, and still compares the others', async () => {
      const notFound = Object.assign(new Error('The requested resource does not exist'), {
        name: 'NOT_FOUND',
        errorCode: 'NOT_FOUND',
      });
      const fields: DescribedField[] = [{ name: 'Name', type: 'string', createable: true }];
      const diff = new ForgeMetadataDiff({
        describeObject: async (orgId, objectApiName) => {
          if (orgId === 'target' && objectApiName === 'Invoice__c') throw notFound;
          if (orgId === 'target' && objectApiName === 'Account') return { fields: [] };
          return { fields };
        },
      });

      const result = await diff.compare('source', 'target', ['Invoice__c', 'Account']);

      expect(result).toEqual([
        {
          objectApiName: 'Invoice__c',
          fieldApiName: '',
          issue: 'object_missing',
          severity: 'error',
          details:
            'Invoice__c does not exist in the target org, or the running user cannot see it: its records cannot be written there',
        },
        {
          objectApiName: 'Account',
          fieldApiName: 'Name',
          issue: 'missing',
          severity: 'error',
          details: 'Field Name exists in source but not in target',
        },
      ]);
    });

    it('names an object an org could not describe for another reason, and goes on', async () => {
      const diff = new ForgeMetadataDiff({
        describeObject: async (orgId, objectApiName) => {
          if (orgId === 'source' && objectApiName === 'Case') {
            throw Object.assign(new Error('Session expired or invalid'), {
              name: 'INVALID_SESSION_ID',
              errorCode: 'INVALID_SESSION_ID',
            });
          }
          return { fields: [{ name: 'Name', type: 'string', createable: true }] };
        },
      });

      const result = await diff.compare('source', 'target', ['Case', 'Account']);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        objectApiName: 'Case',
        fieldApiName: '',
        issue: 'unreadable',
        severity: 'warning',
      });
      expect(result[0].details).toContain('the source org did not describe it');
    });

    it('should detect missing fields as error severity', async () => {
      const deps = makeDeps({
        source: {
          Account: [
            { name: 'Name', type: 'string', createable: true },
            { name: 'Custom__c', type: 'string', createable: true },
          ],
        },
        target: {
          Account: [{ name: 'Name', type: 'string', createable: true }],
        },
      });
      const diff = new ForgeMetadataDiff(deps);

      const result = await diff.compare('source', 'target', ['Account']);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        objectApiName: 'Account',
        fieldApiName: 'Custom__c',
        issue: 'missing',
        severity: 'error',
        details: 'Field Custom__c exists in source but not in target',
      });
    });

    it('should detect type mismatches as warning severity', async () => {
      const deps = makeDeps({
        source: {
          Contact: [{ name: 'Amount', type: 'currency', createable: true }],
        },
        target: {
          Contact: [{ name: 'Amount', type: 'number', createable: true }],
        },
      });
      const diff = new ForgeMetadataDiff(deps);

      const result = await diff.compare('source', 'target', ['Contact']);
      expect(result).toHaveLength(1);
      expect(result[0].issue).toBe('type_mismatch');
      expect(result[0].severity).toBe('warning');
      expect(result[0].details).toContain('source=currency');
      expect(result[0].details).toContain('target=number');
    });

    it('should detect permission denied as warning severity', async () => {
      const deps = makeDeps({
        source: {
          Lead: [{ name: 'Status', type: 'picklist', createable: true }],
        },
        target: {
          Lead: [{ name: 'Status', type: 'picklist', createable: false }],
        },
      });
      const diff = new ForgeMetadataDiff(deps);

      const result = await diff.compare('source', 'target', ['Lead']);
      expect(result).toHaveLength(1);
      expect(result[0].issue).toBe('permission_denied');
      expect(result[0].severity).toBe('warning');
      expect(result[0].details).toContain('createable in source but not in target');
    });

    it('should not flag permission when source is not createable', async () => {
      const deps = makeDeps({
        source: {
          Lead: [{ name: 'Id', type: 'id', createable: false }],
        },
        target: {
          Lead: [{ name: 'Id', type: 'id', createable: false }],
        },
      });
      const diff = new ForgeMetadataDiff(deps);

      const result = await diff.compare('source', 'target', ['Lead']);
      expect(result).toEqual([]);
    });

    it('should process multiple objects', async () => {
      const deps = makeDeps({
        source: {
          Account: [{ name: 'Custom__c', type: 'string', createable: true }],
          Contact: [{ name: 'Title', type: 'string', createable: true }],
        },
        target: {
          Account: [],
          Contact: [{ name: 'Title', type: 'number', createable: true }],
        },
      });
      const diff = new ForgeMetadataDiff(deps);

      const result = await diff.compare('source', 'target', ['Account', 'Contact']);
      expect(result).toHaveLength(2);

      const accountDiff = result.find((d) => d.objectApiName === 'Account');
      expect(accountDiff?.issue).toBe('missing');

      const contactDiff = result.find((d) => d.objectApiName === 'Contact');
      expect(contactDiff?.issue).toBe('type_mismatch');
    });

    it('should handle empty object list', async () => {
      const deps = makeDeps({});
      const diff = new ForgeMetadataDiff(deps);

      const result = await diff.compare('source', 'target', []);
      expect(result).toEqual([]);
    });

    it('should detect both type mismatch and permission denied on the same field', async () => {
      const deps = makeDeps({
        source: {
          Account: [{ name: 'Status', type: 'picklist', createable: true }],
        },
        target: {
          Account: [{ name: 'Status', type: 'string', createable: false }],
        },
      });
      const diff = new ForgeMetadataDiff(deps);

      const result = await diff.compare('source', 'target', ['Account']);
      expect(result).toHaveLength(2);
      expect(result.map((d) => d.issue)).toContain('type_mismatch');
      expect(result.map((d) => d.issue)).toContain('permission_denied');
    });
  });
});
