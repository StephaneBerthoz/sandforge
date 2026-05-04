import { describe, it, expect, vi } from 'vitest';
import { SchemaAnalyzer } from './SchemaAnalyzer';
import type { SchemaConnection, DescribeResult } from './SchemaAnalyzer';

function mockDescribe(
  name: string,
  label: string,
  fields: DescribeResult['fields'] = [],
): DescribeResult {
  return { name, label, fields };
}

function createMockConn(
  describes: Record<string, DescribeResult> = {},
  counts: Record<string, number> = {},
): SchemaConnection {
  return {
    describe: vi.fn().mockImplementation((name: string) => {
      if (describes[name]) return Promise.resolve(describes[name]);
      return Promise.resolve(mockDescribe(name, name));
    }),
    queryCount: vi.fn().mockImplementation((soql: string) => {
      const match = soql.match(/FROM (\w+)/);
      const obj = match?.[1] ?? '';
      return Promise.resolve(counts[obj] ?? 0);
    }),
  };
}

describe('SchemaAnalyzer', () => {
  const analyzer = new SchemaAnalyzer(5);

  it('should return empty ERD for no objects', async () => {
    const conn = createMockConn();
    const result = await analyzer.analyzeSchema(conn, []);
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(result.insertionOrder).toEqual([]);
    expect(result.circularDeps).toEqual([]);
  });

  it('should describe each requested object', async () => {
    const conn = createMockConn({
      Account: mockDescribe('Account', 'Account'),
      Contact: mockDescribe('Contact', 'Contact'),
    });
    const result = await analyzer.analyzeSchema(conn, ['Account', 'Contact']);
    expect(result.nodes.length).toBe(2);
    expect(result.nodes.map((n) => n.apiName).sort()).toEqual(['Account', 'Contact']);
  });

  it('should extract fields from describe result', async () => {
    const conn = createMockConn({
      Account: mockDescribe('Account', 'Account', [
        {
          name: 'Name',
          label: 'Account Name',
          type: 'string',
          nillable: false,
          defaultValue: null,
          unique: false,
          externalId: false,
          length: 255,
        },
      ]),
    });
    const result = await analyzer.analyzeSchema(conn, ['Account']);
    expect(result.nodes[0].fields.length).toBe(1);
    expect(result.nodes[0].fields[0].apiName).toBe('Name');
    expect(result.nodes[0].fields[0].required).toBe(true);
    expect(result.nodes[0].fields[0].maxLength).toBe(255);
  });

  it('should extract Lookup relationships', async () => {
    const conn = createMockConn({
      Contact: mockDescribe('Contact', 'Contact', [
        {
          name: 'AccountId',
          label: 'Account',
          type: 'reference',
          nillable: true,
          defaultValue: null,
          referenceTo: ['Account'],
          unique: false,
          externalId: false,
        },
      ]),
      Account: mockDescribe('Account', 'Account'),
    });
    const result = await analyzer.analyzeSchema(conn, ['Contact', 'Account']);
    expect(result.edges.length).toBe(1);
    expect(result.edges[0]).toEqual({
      source: 'Contact',
      target: 'Account',
      field: 'AccountId',
      type: 'Lookup',
    });
  });

  it('should extract MasterDetail relationships', async () => {
    const conn = createMockConn({
      OpportunityLineItem: mockDescribe('OpportunityLineItem', 'Opp Line Item', [
        {
          name: 'OpportunityId',
          label: 'Opportunity',
          type: 'masterdetail',
          nillable: false,
          defaultValue: null,
          referenceTo: ['Opportunity'],
          unique: false,
          externalId: false,
        },
      ]),
      Opportunity: mockDescribe('Opportunity', 'Opportunity'),
    });
    const result = await analyzer.analyzeSchema(conn, ['OpportunityLineItem', 'Opportunity']);
    expect(result.edges[0].type).toBe('MasterDetail');
    expect(
      result.nodes.find((n) => n.apiName === 'OpportunityLineItem')!.relationships[0].required,
    ).toBe(true);
  });

  it('should auto-add missing parent objects', async () => {
    const conn = createMockConn({
      Contact: mockDescribe('Contact', 'Contact', [
        {
          name: 'AccountId',
          label: 'Account',
          type: 'reference',
          nillable: true,
          defaultValue: null,
          referenceTo: ['Account'],
          unique: false,
          externalId: false,
        },
      ]),
      Account: mockDescribe('Account', 'Account'),
    });

    // Only request Contact, Account should be auto-added
    const result = await analyzer.analyzeSchema(conn, ['Contact']);
    expect(result.nodes.length).toBe(2);
    expect(result.nodes.map((n) => n.apiName).sort()).toEqual(['Account', 'Contact']);
    expect(result.warnings.some((w) => w.includes('Account auto-added'))).toBe(true);
  });

  it('should compute topological insertion order', async () => {
    const conn = createMockConn({
      Account: mockDescribe('Account', 'Account'),
      Contact: mockDescribe('Contact', 'Contact', [
        {
          name: 'AccountId',
          label: 'Account',
          type: 'reference',
          nillable: true,
          defaultValue: null,
          referenceTo: ['Account'],
          unique: false,
          externalId: false,
        },
      ]),
      Case: mockDescribe('Case', 'Case', [
        {
          name: 'ContactId',
          label: 'Contact',
          type: 'reference',
          nillable: true,
          defaultValue: null,
          referenceTo: ['Contact'],
          unique: false,
          externalId: false,
        },
      ]),
    });

    const result = await analyzer.analyzeSchema(conn, ['Case', 'Contact', 'Account']);
    const accountIdx = result.insertionOrder.indexOf('Account');
    const contactIdx = result.insertionOrder.indexOf('Contact');
    const caseIdx = result.insertionOrder.indexOf('Case');
    expect(accountIdx).toBeLessThan(contactIdx);
    expect(contactIdx).toBeLessThan(caseIdx);
  });

  it('should detect circular dependencies', async () => {
    const conn = createMockConn({
      A: mockDescribe('A', 'Object A', [
        {
          name: 'BId',
          label: 'B',
          type: 'reference',
          nillable: true,
          defaultValue: null,
          referenceTo: ['B'],
          unique: false,
          externalId: false,
        },
      ]),
      B: mockDescribe('B', 'Object B', [
        {
          name: 'AId',
          label: 'A',
          type: 'reference',
          nillable: true,
          defaultValue: null,
          referenceTo: ['A'],
          unique: false,
          externalId: false,
        },
      ]),
    });

    const result = await analyzer.analyzeSchema(conn, ['A', 'B']);
    expect(result.circularDeps.length).toBe(1);
    expect(result.warnings.some((w) => w.includes('Circular dependency'))).toBe(true);
  });

  it('should fetch record counts', async () => {
    const conn = createMockConn(
      {
        Account: mockDescribe('Account', 'Account'),
        Contact: mockDescribe('Contact', 'Contact'),
      },
      { Account: 5000, Contact: 12000 },
    );
    const result = await analyzer.analyzeSchema(conn, ['Account', 'Contact']);
    expect(result.nodes.find((n) => n.apiName === 'Account')!.recordCount).toBe(5000);
    expect(result.nodes.find((n) => n.apiName === 'Contact')!.recordCount).toBe(12000);
  });

  it('should generate MasterDetail warnings', async () => {
    const conn = createMockConn({
      Child: mockDescribe('Child', 'Child', [
        {
          name: 'ParentId',
          label: 'Parent',
          type: 'masterdetail',
          nillable: false,
          defaultValue: null,
          referenceTo: ['Parent'],
          unique: false,
          externalId: false,
        },
      ]),
      Parent: mockDescribe('Parent', 'Parent'),
    });
    const result = await analyzer.analyzeSchema(conn, ['Child', 'Parent']);
    expect(result.warnings.some((w) => w.includes('MasterDetail'))).toBe(true);
  });

  it('should extract picklist values', async () => {
    const conn = createMockConn({
      Account: mockDescribe('Account', 'Account', [
        {
          name: 'Industry',
          label: 'Industry',
          type: 'picklist',
          nillable: true,
          defaultValue: null,
          picklistValues: [
            { value: 'Tech', active: true },
            { value: 'Finance', active: true },
            { value: 'Old', active: false },
          ],
          unique: false,
          externalId: false,
        },
      ]),
    });
    const result = await analyzer.analyzeSchema(conn, ['Account']);
    const field = result.nodes[0].fields[0];
    expect(field.picklistValues).toEqual(['Tech', 'Finance']);
  });

  it('should handle describe failures gracefully', async () => {
    const conn = createMockConn();
    (conn.describe as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('No access'));
    const result = await analyzer.analyzeSchema(conn, ['Restricted']);
    expect(result.nodes.length).toBe(0);
  });

  it('should respect concurrency limit', async () => {
    const objects = Array.from({ length: 15 }, (_, i) => `Obj${i}`);
    const describes: Record<string, DescribeResult> = {};
    for (const name of objects) {
      describes[name] = mockDescribe(name, name);
    }
    const conn = createMockConn(describes);

    await analyzer.analyzeSchema(conn, objects);
    // With maxConcurrent=5, should have made 3 batches
    expect(conn.describe).toHaveBeenCalledTimes(15);
  });

  it('should handle objects with no relationships', async () => {
    const conn = createMockConn({
      Account: mockDescribe('Account', 'Account', [
        {
          name: 'Name',
          label: 'Name',
          type: 'string',
          nillable: false,
          defaultValue: null,
          unique: false,
          externalId: false,
        },
      ]),
    });
    const result = await analyzer.analyzeSchema(conn, ['Account']);
    expect(result.edges).toEqual([]);
    expect(result.insertionOrder).toEqual(['Account']);
    expect(result.circularDeps).toEqual([]);
  });
});
