/**
 * ForgeComplianceService generates compliance reports for Forge operations.
 * Thin wrapper around ComplianceEngine from Autopilot, adapting ForgeGraph inputs.
 */

import type { ForgeConfig, ForgeGraph } from '@sandforge/shared';
import type {
  ComplianceFrameworkType,
  ComplianceReport,
  PIIFieldDetection,
  AutopilotAnonymizationRule,
} from '@sandforge/shared';
import { ComplianceEngine } from '../autopilot/ComplianceEngine.js';
import { ForgeAnonymizer, type ForgeAnonymizationMethods } from './ForgeAnonymizer.js';
import { knowsItsFields } from './GraphDiscoveryService.js';

/** The settings of the run a report describes. */
export type ForgeComplianceRun = Pick<ForgeConfig, 'sourceOrgId' | 'targetOrgId' | 'anonymizePII'>;

/**
 * Generates compliance reports for Forge operations.
 * Wraps ComplianceEngine from Autopilot.
 */
export class ForgeComplianceService {
  private readonly engine: ComplianceEngine;
  /** Read for its categories and default methods: the ones the run applies. */
  private readonly anonymizer: ForgeAnonymizer;

  constructor() {
    this.engine = new ComplianceEngine();
    this.anonymizer = new ForgeAnonymizer();
  }

  /**
   * Generate a compliance report on what a run would write.
   *
   * It used to describe a run of its own: every personal field labelled
   * `fake`, by rules it generated from the framework, and the report `pass`
   * because those rules covered what it had detected — with the run's
   * anonymize toggle off, and whatever fields and methods the run would
   * actually use. It reads the run's settings now, as `runAnonymization` does
   * before a write: nothing is anonymized with the toggle off; with it on, the
   * fields selected on each node, each with the method Review holds for its
   * category, or that category's default. A personal field the run writes as
   * it is gets no rule, so its object is reported `partial` or `fail`, and the
   * report is never `pass` while one is.
   *
   * The category is read from the field's name, the graph carrying no field
   * types: the run also reads the type, so a field typed as an email or a
   * phone under another name is named here by its pattern alone.
   *
   * An object whose fields were never read — a starter template's node the
   * plan could not describe — names no personal field, and the run decides at
   * the write which of its fields are. With the toggle on, it anonymizes them
   * then; with it off, they are written as they are, so a report that found
   * no personal field elsewhere is `partial`, not `pass`.
   *
   * @param framework - The compliance framework to apply.
   * @param graph - The Forge dependency graph, with the fields detected and
   *   selected on each node.
   * @param run - The run's orgs and its anonymize toggle.
   * @param methods - The method Review holds per category; a category left
   *   out takes its default, as in the run.
   * @returns A compliance report, or null if framework is "none".
   */
  generate(
    framework: ComplianceFrameworkType,
    graph: ForgeGraph,
    run: ForgeComplianceRun,
    methods: ForgeAnonymizationMethods = {},
  ): ComplianceReport | null {
    if (framework === 'none') return null;

    const piiDetections: PIIFieldDetection[] = [];
    const rules: AutopilotAnonymizationRule[] = [];
    let totalFieldsScanned = 0;
    let unreadObjects = 0;

    for (const node of graph.nodes) {
      if (!node.included) continue;
      totalFieldsScanned += node.fieldCount;
      if (!knowsItsFields(node)) unreadObjects++;
      const selected = new Set(run.anonymizePII ? node.anonymizeFields : []);
      for (const fieldName of node.piiFields) {
        const category = this.anonymizer.categorizeField(fieldName, '');
        const defaultMethod = this.anonymizer.getDefaultMethod(category);
        const method = methods[category] ?? defaultMethod;
        piiDetections.push({
          objectApiName: node.objectApiName,
          fieldApiName: fieldName,
          fieldLabel: fieldName,
          fieldType: 'string',
          piiCategory: 'PII',
          detectionMethod: 'field_name',
          confidence: 0.9,
          suggestedMethod: method,
        });
        if (!selected.has(fieldName)) continue;
        rules.push({
          objectApiName: node.objectApiName,
          fieldApiName: fieldName,
          method,
          piiCategory: 'PII',
          aiConfidence: 0.9,
          userOverridden: method !== defaultMethod,
        });
      }
    }

    const profile = this.engine.buildProfile(framework, piiDetections);

    const recordCounts = new Map<string, number>();
    for (const node of graph.nodes) {
      if (node.included) {
        recordCounts.set(node.objectApiName, node.recordCount);
      }
    }

    const report = this.engine.generateReport(
      profile,
      rules,
      recordCounts,
      run.sourceOrgId,
      run.targetOrgId,
      totalFieldsScanned,
    );
    return report.overallStatus === 'pass' && unreadObjects > 0 && !run.anonymizePII
      ? { ...report, overallStatus: 'partial' }
      : report;
  }
}
