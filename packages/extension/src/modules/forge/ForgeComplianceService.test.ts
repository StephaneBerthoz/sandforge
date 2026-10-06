import { describe, it, expect } from 'vitest';
import { ForgeComplianceService } from './ForgeComplianceService.js';
import type { ForgeComplianceRun } from './ForgeComplianceService.js';
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

/** A run that anonymizes, or not, between two orgs. */
function run(anonymizePII: boolean): ForgeComplianceRun {
  return { sourceOrgId: 'src-org', targetOrgId: 'tgt-org', anonymizePII };
}

/** A contact whose two personal fields are both selected for anonymization. */
const contact = (overrides: Partial<ForgeGraphNode> = {}): ForgeGraphNode =>
  makeNode({
    objectApiName: 'Contact',
    piiFields: ['Email', 'Phone'],
    anonymizeFields: ['Email', 'Phone'],
    fieldCount: 20,
    recordCount: 500,
    ...overrides,
  });

describe('ForgeComplianceService', () => {
  const service = new ForgeComplianceService();

  describe('generate', () => {
    it('should return null for "none" framework', () => {
      const graph = makeGraph([makeNode({ objectApiName: 'Account', piiFields: ['Email'] })]);
      expect(service.generate('none', graph, run(true))).toBeNull();
    });

    it('fails a run that writes every personal field as it is: the anonymize toggle is off', () => {
      // It reported `pass` here: its own rules labelled every detected field
      // `fake`, whatever the run would write.
      const report = service.generate('gdpr', makeGraph([contact()]), run(false))!;

      expect(report.overallStatus).toBe('fail');
      expect(report.piiFieldsDetected).toBe(2);
      expect(report.piiFieldsAnonymized).toBe(0);
      expect(report.entries).toEqual([]);
      expect(report.objectSummaries).toEqual([
        expect.objectContaining({ objectApiName: 'Contact', status: 'fail', piiFieldCount: 2 }),
      ]);
    });

    it('passes a run that anonymizes every personal field, each with the method it applies', () => {
      const report = service.generate('gdpr', makeGraph([contact()]), run(true), {
        email: 'hash',
      })!;

      expect(report.overallStatus).toBe('pass');
      expect(report.piiFieldsAnonymized).toBe(2);
      // The method Review holds for email, and the default of a phone, not
      // `fake` for both.
      expect(
        Object.fromEntries(report.entries.map((e) => [e.fieldApiName, e.anonymizationMethod])),
      ).toEqual({ Email: 'hash', Phone: 'mask' });
      expect(report.entries.map((e) => e.recordsAnonymized)).toEqual([500, 500]);
    });

    it('is never pass while a personal field deselected on its node is written as it is', () => {
      const report = service.generate(
        'gdpr',
        makeGraph([contact({ anonymizeFields: ['Email'] })]),
        run(true),
      )!;

      expect(report.overallStatus).toBe('partial');
      expect(report.piiFieldsAnonymized).toBe(1);
      expect(report.entries.map((e) => e.fieldApiName)).toEqual(['Email']);
    });

    it('fails an object none of whose personal fields is selected, beside one that passes', () => {
      const report = service.generate(
        'ccpa',
        makeGraph([
          contact(),
          makeNode({ objectApiName: 'Lead', piiFields: ['Email'], anonymizeFields: [] }),
        ]),
        run(true),
      )!;

      expect(report.overallStatus).toBe('partial');
      const status = Object.fromEntries(
        report.objectSummaries.map((s) => [s.objectApiName, s.status]),
      );
      expect(status).toEqual({ Contact: 'pass', Lead: 'fail' });
    });

    it('says which method the user chose over its category’s default', () => {
      const report = service.generate('gdpr', makeGraph([contact()]), run(true), {
        email: 'hash',
        phone: 'mask',
      })!;

      const overridden = Object.fromEntries(
        report.entries.map((e) => [e.fieldApiName, e.userOverridden]),
      );
      expect(overridden).toEqual({ Email: true, Phone: false });
    });

    it('reports on the framework asked for, under its own rules', () => {
      const graph = makeGraph([contact()]);
      const gdpr = service.generate('gdpr', graph, run(true))!;
      const hipaa = service.generate('hipaa', graph, run(true))!;

      expect(gdpr.framework).toBe('gdpr');
      expect(hipaa.framework).toBe('hipaa');
      expect(gdpr.entries.map((e) => e.ruleApplied)).toEqual(['gdpr-01', 'gdpr-01']);
      expect(hipaa.entries.map((e) => e.ruleApplied)).toEqual(['hipaa-01', 'hipaa-01']);
    });

    it('does not pass a run that writes, as they are, objects whose fields were never read', () => {
      // A starter template's node the plan could not describe names no
      // personal field: with the toggle off, whatever it holds is written.
      const unread = makeNode({ objectApiName: 'Account', fieldCount: 0, piiFields: [] });
      const off = service.generate('gdpr', makeGraph([unread]), run(false))!;
      const on = service.generate('gdpr', makeGraph([unread]), run(true))!;

      expect(off.overallStatus).toBe('partial');
      // With the toggle on, the run anonymizes the personal fields it finds there.
      expect(on.overallStatus).toBe('pass');
    });

    it('should include per-object summaries', () => {
      const graph = makeGraph([
        makeNode({ objectApiName: 'Account', piiFields: ['Email'], recordCount: 100 }),
        makeNode({ objectApiName: 'Contact', piiFields: ['Phone'], recordCount: 200 }),
      ]);
      const report = service.generate('ccpa', graph, run(true))!;

      expect(report.objectSummaries.length).toBe(2);
      const accountSummary = report.objectSummaries.find((s) => s.objectApiName === 'Account');
      expect(accountSummary!.recordCount).toBe(100);
    });

    it('should produce a hex string checksum', () => {
      const report = service.generate('hipaa', makeGraph([contact()]), run(true))!;
      expect(report.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should skip excluded nodes when counting fields', () => {
      const graph = makeGraph([
        makeNode({ objectApiName: 'Account', piiFields: ['Email'], fieldCount: 15 }),
        makeNode({
          objectApiName: 'Lead',
          piiFields: ['Phone'],
          fieldCount: 10,
          included: false,
        }),
      ]);
      const report = service.generate('gdpr', graph, run(true))!;

      expect(report.totalFieldsScanned).toBe(15);
      expect(report.piiFieldsDetected).toBe(1);
      expect(report.sourceOrgId).toBe('src-org');
      expect(report.targetOrgId).toBe('tgt-org');
    });

    it('passes a graph with no personal field, whose fields were all read', () => {
      const graph = makeGraph([makeNode({ objectApiName: 'Account', fieldCount: 10 })]);
      const report = service.generate('gdpr', graph, run(false))!;

      expect(report.piiFieldsDetected).toBe(0);
      expect(report.entries).toHaveLength(0);
      expect(report.overallStatus).toBe('pass');
    });
  });
});
