import { describe, it, expect } from 'vitest';
import type { ComplianceFrameworkType, AnonymizationMethod } from './common.types.js';
import type {
  AutopilotGraph,
  AutopilotNode,
  AutopilotEdge,
  ExecutionPlan,
  AutopilotConfig,
  PIIFieldDetection,
  AnonymizedPersona,
} from './autopilot.types.js';

describe('autopilot.types', () => {
  it('should compile AutopilotNode with all required fields', () => {
    const node: AutopilotNode = {
      objectApiName: 'Account',
      recordCount: 100,
      estimatedApiCalls: 1,
      piiFields: [],
      anonymizationRules: [],
      status: 'pending',
      progress: 0,
      insertOrder: 0,
      level: 0,
      successCount: 0,
      failureCount: 0,
      errors: [],
      elapsedMs: 0,
      apiCallsUsed: 0,
    };
    expect(node.objectApiName).toBe('Account');
  });

  it('should support all AutopilotNodeStatus values', () => {
    const statuses: AutopilotNode['status'][] = [
      'pending',
      'queued',
      'extracting',
      'anonymizing',
      'loading',
      'completed',
      'failed',
      'skipped',
    ];
    expect(statuses).toHaveLength(8);
  });

  it('should support all ComplianceFrameworkType values', () => {
    const frameworks: ComplianceFrameworkType[] = [
      'gdpr',
      'ccpa',
      'hipaa',
      'pci_dss',
      'custom',
      'none',
    ];
    expect(frameworks).toHaveLength(6);
  });

  it('should support all AnonymizationMethod values', () => {
    const methods: AnonymizationMethod[] = [
      'fake',
      'mask',
      'hash',
      'nullify',
      'redact',
      'shuffle',
      'truncate',
      'preserve_format',
      'age_band',
      'generalize',
      'constant',
    ];
    expect(methods).toHaveLength(11);
  });

  it('should compile ExecutionPlan', () => {
    const plan: ExecutionPlan = {
      waves: [{ order: 0, objects: ['User'], dependsOn: [] }],
      totalRecords: 100,
      estimatedDurationSec: 60,
      estimatedApiCalls: 10,
      complianceFramework: 'gdpr',
      anonymizationSummary: {
        totalPiiFields: 5,
        totalFieldsToAnonymize: 5,
        methodBreakdown: {
          fake: 3,
          mask: 1,
          hash: 1,
          nullify: 0,
          redact: 0,
          shuffle: 0,
          truncate: 0,
          preserve_format: 0,
          age_band: 0,
          generalize: 0,
          constant: 0,
        },
        objectsWithPii: ['Contact'],
      },
      cycleResolutions: [],
    };
    expect(plan.waves).toHaveLength(1);
  });

  it('should compile AutopilotEdge', () => {
    const edge: AutopilotEdge = {
      from: 'Account',
      to: 'Contact',
      fieldApiName: 'AccountId',
      relationshipType: 'lookup',
      required: false,
    };
    expect(edge.from).toBe('Account');
  });

  it('should compile AutopilotGraph', () => {
    const graph: AutopilotGraph = {
      nodes: [],
      edges: [],
      cycles: [],
      stats: {
        totalObjects: 0,
        totalRelationships: 0,
        cycleCount: 0,
        maxDepth: 0,
        totalRecords: 0,
        totalEstimatedApiCalls: 0,
      },
    };
    expect(graph.nodes).toHaveLength(0);
  });

  it('should compile AutopilotConfig', () => {
    const config: AutopilotConfig = {
      sourceOrgId: 'org-1',
      targetOrgId: 'org-2',
      selectedObjects: ['Account', 'Contact'],
      complianceFramework: 'gdpr',
      maxRecordsPerObject: 1000,
      objectFilters: { Account: "Industry = 'Tech'" },
      includeStandardObjects: true,
      grappeThreshold: 10000,
    };
    expect(config.selectedObjects).toHaveLength(2);
  });

  it('should compile PIIFieldDetection', () => {
    const detection: PIIFieldDetection = {
      objectApiName: 'Contact',
      fieldApiName: 'Email',
      fieldLabel: 'Email Address',
      fieldType: 'email',
      piiCategory: 'PII',
      detectionMethod: 'field_name',
      confidence: 0.95,
      suggestedMethod: 'fake',
    };
    expect(detection.confidence).toBe(0.95);
  });

  it('should compile AnonymizedPersona', () => {
    const persona: AnonymizedPersona = {
      sourceRecordId: '003xx000004TmiU',
      firstName: 'Jane',
      lastName: 'Doe',
      email: 'jane.doe@example.com',
      phone: '+1-555-0100',
      address: '123 Fake St',
      city: 'Springfield',
      postalCode: '62701',
      company: 'Acme Corp',
    };
    expect(persona.firstName).toBe('Jane');
  });
});
