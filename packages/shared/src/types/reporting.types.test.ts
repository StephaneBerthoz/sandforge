import { describe, it, expect } from 'vitest';
import type {
  GeneratedReport,
  AuditLogEntry,
  DataLineageGraph,
  ReportSection,
  ReportMetadata,
  LineageNode,
  LineageEdge,
} from './reporting.types.js';

describe('reporting.types', () => {
  describe('GeneratedReport', () => {
    it('should accept a valid GeneratedReport with all required fields', () => {
      const section: ReportSection = {
        title: 'Summary',
        type: 'summary',
        content: { totalRecords: 150, successRate: 0.98 },
        order: 1,
      };

      const metadata: ReportMetadata = {
        orgId: 'org-001',
        operationId: 'op-abc-123',
        module: 'seed',
        duration: 12500,
        recordCount: 150,
      };

      const report: GeneratedReport = {
        id: 'rpt-001-uuid',
        definitionId: 'def-001-uuid',
        type: 'seed_execution',
        title: 'Seed Execution Report',
        summary: 'Successfully seeded 150 Account records.',
        sections: [section],
        metadata,
        generatedAt: '2026-02-20T10:00:00.000Z',
      };

      expect(report.id).toBe('rpt-001-uuid');
      expect(report.type).toBe('seed_execution');
      expect(report.sections).toHaveLength(1);
      expect(report.sections[0].type).toBe('summary');
      expect(report.metadata.module).toBe('seed');
    });

    it('should accept a report with multiple sections and optional metadata fields', () => {
      const report: GeneratedReport = {
        id: 'rpt-002-uuid',
        definitionId: 'def-002-uuid',
        type: 'data_quality',
        title: 'Data Quality Report',
        summary: 'Found 3 data quality issues.',
        sections: [
          { title: 'Overview', type: 'text', content: { text: 'Report overview' }, order: 0 },
          { title: 'Details', type: 'detail', content: { issues: [] }, order: 1 },
          { title: 'Metrics', type: 'chart', content: { chartType: 'bar' }, order: 2 },
        ],
        metadata: {
          module: 'monitor',
          exportedAs: 'html',
        },
        generatedAt: '2026-02-20T14:30:00.000Z',
      };

      expect(report.sections).toHaveLength(3);
      expect(report.metadata.orgId).toBeUndefined();
      expect(report.metadata.exportedAs).toBe('html');
    });
  });

  describe('AuditLogEntry', () => {
    it('should accept a valid AuditLogEntry with required fields', () => {
      const entry: AuditLogEntry = {
        id: 'audit-001-uuid',
        action: 'seed_execute',
        module: 'seed',
        details: { recordCount: 200, objectApiName: 'Account' },
        timestamp: '2026-02-20T09:15:00.000Z',
      };

      expect(entry.id).toBe('audit-001-uuid');
      expect(entry.action).toBe('seed_execute');
      expect(entry.module).toBe('seed');
      expect(entry.details).toHaveProperty('recordCount', 200);
      expect(entry.orgId).toBeUndefined();
      expect(entry.userId).toBeUndefined();
    });

    it('should accept an AuditLogEntry with all optional fields', () => {
      const entry: AuditLogEntry = {
        id: 'audit-002-uuid',
        action: 'org_connect',
        module: 'connection',
        orgId: 'org-prod-001',
        userId: 'user-admin-001',
        details: { authMethod: 'oauth2', environment: 'production' },
        timestamp: '2026-02-20T08:00:00.000Z',
        ipAddress: '192.168.1.100',
      };

      expect(entry.orgId).toBe('org-prod-001');
      expect(entry.userId).toBe('user-admin-001');
      expect(entry.ipAddress).toBe('192.168.1.100');
    });
  });

  describe('DataLineageGraph', () => {
    it('should accept a valid DataLineageGraph with nodes and edges', () => {
      const sourceNode: LineageNode = {
        id: 'node-src-001',
        type: 'source',
        label: 'Production Accounts',
        objectApiName: 'Account',
        orgId: 'org-prod-001',
      };

      const destNode: LineageNode = {
        id: 'node-dst-001',
        type: 'destination',
        label: 'Sandbox Accounts',
        objectApiName: 'Account',
        orgId: 'org-sandbox-001',
      };

      const edge: LineageEdge = {
        sourceId: 'node-src-001',
        targetId: 'node-dst-001',
        label: 'Sync copy',
        recordCount: 500,
      };

      const graph: DataLineageGraph = {
        nodes: [sourceNode, destNode],
        edges: [edge],
        operationId: 'op-sync-001',
        generatedAt: '2026-02-20T11:00:00.000Z',
      };

      expect(graph.nodes).toHaveLength(2);
      expect(graph.edges).toHaveLength(1);
      expect(graph.edges[0].sourceId).toBe('node-src-001');
      expect(graph.edges[0].targetId).toBe('node-dst-001');
      expect(graph.operationId).toBe('op-sync-001');
    });

    it('should accept an empty graph with no nodes or edges', () => {
      const emptyGraph: DataLineageGraph = {
        nodes: [],
        edges: [],
        operationId: 'op-empty-001',
        generatedAt: '2026-02-20T12:00:00.000Z',
      };

      expect(emptyGraph.nodes).toHaveLength(0);
      expect(emptyGraph.edges).toHaveLength(0);
    });
  });
});
