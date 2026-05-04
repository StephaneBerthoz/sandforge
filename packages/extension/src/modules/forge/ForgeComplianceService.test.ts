import { describe, it, expect } from 'vitest';
import { ForgeComplianceService } from './ForgeComplianceService.js';
import type { ForgeGraph, ForgeGraphNode } from '@sandforge/shared';

function makeNode(overrides: Partial<ForgeGraphNode> & { objectApiName: string }): ForgeGraphNode {
  return {
    recordCount: 100,
    fieldCount: 10,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level: 0,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 8,
    estimatedSizeMB: 1,
    estimatedApiCalls: 1,
    batchStrategy: 'auto',
    ...overrides,
  };
}

function makeGraph(nodes: ForgeGraphNode[]): ForgeGraph {
  return {
    nodes,
    edges: [],
    totalRecords: nodes.reduce((s, n) => s + n.recordCount, 0),
    estimatedSizeMB: nodes.reduce((s, n) => s + n.estimatedSizeMB, 0),
    estimatedDurationSeconds: 0,
  };
}

describe('ForgeComplianceService', () => {
  const service = new ForgeComplianceService();

  describe('generate', () => {
    it('should return null for "none" framework', () => {
      const graph = makeGraph([makeNode({ objectApiName: 'Account', piiFields: ['Email'] })]);
      const result = service.generate('none', graph, 'src-org', 'tgt-org');

      expect(result).toBeNull();
    });

    it('should generate report with entries for gdpr framework', () => {
      const graph = makeGraph([
        makeNode({
          objectApiName: 'Contact',
          piiFields: ['Email', 'Phone'],
          fieldCount: 20,
          recordCount: 500,
        }),
      ]);
      const report = service.generate('gdpr', graph, 'src-org', 'tgt-org');

      expect(report).not.toBeNull();
      expect(report!.framework).toBe('gdpr');
      expect(report!.sourceOrgId).toBe('src-org');
      expect(report!.targetOrgId).toBe('tgt-org');
      expect(report!.entries.length).toBeGreaterThan(0);
      expect(report!.totalFieldsScanned).toBe(20);
      expect(report!.piiFieldsDetected).toBe(2);
    });

    it('should include per-object summaries', () => {
      const graph = makeGraph([
        makeNode({
          objectApiName: 'Account',
          piiFields: ['Email'],
          recordCount: 100,
        }),
        makeNode({
          objectApiName: 'Contact',
          piiFields: ['Phone'],
          recordCount: 200,
        }),
      ]);
      const report = service.generate('ccpa', graph, 'src', 'tgt');

      expect(report).not.toBeNull();
      expect(report!.objectSummaries.length).toBeGreaterThanOrEqual(2);
      const accountSummary = report!.objectSummaries.find((s) => s.objectApiName === 'Account');
      expect(accountSummary).toBeDefined();
      expect(accountSummary!.recordCount).toBe(100);
    });

    it('should compute overall status correctly', () => {
      const graph = makeGraph([
        makeNode({
          objectApiName: 'Contact',
          piiFields: ['Email'],
          recordCount: 100,
        }),
      ]);
      const report = service.generate('gdpr', graph, 'src', 'tgt');

      expect(report).not.toBeNull();
      expect(['pass', 'partial', 'fail']).toContain(report!.overallStatus);
    });

    it('should produce a hex string checksum', () => {
      const graph = makeGraph([
        makeNode({
          objectApiName: 'Contact',
          piiFields: ['Email'],
        }),
      ]);
      const report = service.generate('hipaa', graph, 'src', 'tgt');

      expect(report).not.toBeNull();
      expect(report!.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should skip excluded nodes when counting fields', () => {
      const graph = makeGraph([
        makeNode({
          objectApiName: 'Account',
          piiFields: ['Email'],
          fieldCount: 15,
          included: true,
        }),
        makeNode({
          objectApiName: 'Lead',
          piiFields: ['Phone'],
          fieldCount: 10,
          included: false,
        }),
      ]);
      const report = service.generate('gdpr', graph, 'src', 'tgt');

      expect(report).not.toBeNull();
      // Only Account (15 fields) should be counted
      expect(report!.totalFieldsScanned).toBe(15);
      // Only Account PII fields should be detected
      expect(report!.piiFieldsDetected).toBe(1);
    });

    it('should handle graph with no PII fields', () => {
      const graph = makeGraph([
        makeNode({
          objectApiName: 'Account',
          piiFields: [],
          fieldCount: 10,
        }),
      ]);
      const report = service.generate('gdpr', graph, 'src', 'tgt');

      expect(report).not.toBeNull();
      expect(report!.piiFieldsDetected).toBe(0);
      expect(report!.entries).toHaveLength(0);
    });

    it('should work with pci_dss framework', () => {
      const graph = makeGraph([
        makeNode({
          objectApiName: 'Payment__c',
          piiFields: ['CardNumber__c'],
          recordCount: 50,
        }),
      ]);
      const report = service.generate('pci_dss', graph, 'src', 'tgt');

      expect(report).not.toBeNull();
      expect(report!.framework).toBe('pci_dss');
      expect(report!.entries.length).toBeGreaterThan(0);
    });
  });
});
