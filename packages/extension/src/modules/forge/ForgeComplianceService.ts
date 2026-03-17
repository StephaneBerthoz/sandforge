/**
 * ForgeComplianceService generates compliance reports for Forge operations.
 * Thin wrapper around ComplianceEngine from Autopilot, adapting ForgeGraph inputs.
 */

import type { ForgeGraph } from '@sandforge/shared';
import type {
  ComplianceFrameworkType,
  ComplianceReport,
  PIIFieldDetection,
  PIICategory,
  AnonymizationMethod,
} from '@sandforge/shared';
import { ComplianceEngine } from '../autopilot/ComplianceEngine.js';

/**
 * Generates compliance reports for Forge operations.
 * Wraps ComplianceEngine from Autopilot.
 */
export class ForgeComplianceService {
  private readonly engine: ComplianceEngine;

  constructor() {
    this.engine = new ComplianceEngine();
  }

  /**
   * Generate a compliance report from a graph and framework.
   *
   * @param framework - The compliance framework to apply.
   * @param graph - The Forge dependency graph with PII metadata.
   * @param sourceOrgId - Source Salesforce org identifier.
   * @param targetOrgId - Target Salesforce org identifier.
   * @returns A compliance report, or null if framework is "none".
   */
  generate(
    framework: ComplianceFrameworkType,
    graph: ForgeGraph,
    sourceOrgId: string,
    targetOrgId: string,
  ): ComplianceReport | null {
    if (framework === 'none') return null;

    // Extract PII detections from graph nodes
    const piiDetections: PIIFieldDetection[] = [];
    let totalFieldsScanned = 0;

    for (const node of graph.nodes) {
      if (!node.included) continue;
      totalFieldsScanned += node.fieldCount;
      for (const fieldName of node.piiFields) {
        piiDetections.push({
          objectApiName: node.objectApiName,
          fieldApiName: fieldName,
          fieldLabel: fieldName,
          fieldType: 'string',
          piiCategory: 'PII' as PIICategory,
          detectionMethod: 'field_name',
          confidence: 0.9,
          suggestedMethod: 'fake' as AnonymizationMethod,
        });
      }
    }

    const profile = this.engine.buildProfile(framework, piiDetections);
    const rules = this.engine.generateRules(profile);

    const recordCounts = new Map<string, number>();
    for (const node of graph.nodes) {
      if (node.included) {
        recordCounts.set(node.objectApiName, node.recordCount);
      }
    }

    return this.engine.generateReport(
      profile,
      rules,
      recordCounts,
      sourceOrgId,
      targetOrgId,
      totalFieldsScanned,
    );
  }
}
