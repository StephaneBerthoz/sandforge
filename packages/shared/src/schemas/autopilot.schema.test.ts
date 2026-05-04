import { describe, it, expect } from 'vitest';

import {
  autopilotNodeStatusSchema,
  autopilotRelationshipTypeSchema,
  anonymizationMethodSchema,
  piiCategorySchema,
  complianceFrameworkTypeSchema,
  autopilotNodeSchema,
  autopilotEdgeSchema,
  cycleResolutionSchema,
  graphStatsSchema,
  autopilotGraphSchema,
  executionWaveSchema,
  executionPlanSchema,
  piiFieldDetectionSchema,
  anonymizationRuleSchema,
  anonymizedPersonaSchema,
  autopilotConfigSchema,
  autopilotEventSchema,
} from './autopilot.schema.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createValidPiiFieldDetection(): Record<string, unknown> {
  return {
    objectApiName: 'Contact',
    fieldApiName: 'Email',
    fieldLabel: 'Email Address',
    fieldType: 'email',
    piiCategory: 'PII',
    detectionMethod: 'field_name',
    confidence: 0.95,
    suggestedMethod: 'fake',
  };
}

function createValidAnonymizationRule(): Record<string, unknown> {
  return {
    objectApiName: 'Contact',
    fieldApiName: 'Email',
    method: 'fake',
    piiCategory: 'PII',
    aiConfidence: 0.95,
    userOverridden: false,
  };
}

function createValidAutopilotNode(): Record<string, unknown> {
  return {
    objectApiName: 'Account',
    recordCount: 100,
    estimatedApiCalls: 5,
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
}

function createValidAutopilotEdge(): Record<string, unknown> {
  return {
    from: 'Account',
    to: 'Contact',
    fieldApiName: 'AccountId',
    relationshipType: 'lookup',
    required: false,
  };
}

function createValidGraphStats(): Record<string, unknown> {
  return {
    totalObjects: 2,
    totalRelationships: 1,
    cycleCount: 0,
    maxDepth: 1,
    totalRecords: 200,
    totalEstimatedApiCalls: 10,
  };
}

function createValidCycleResolution(): Record<string, unknown> {
  return {
    objects: ['Account', 'Contact'],
    strategy: 'two_pass',
    description: 'Two-pass insertion to resolve Account <-> Contact cycle',
  };
}

// ─── Enum Schema Tests ───────────────────────────────────────────────────────

describe('autopilotNodeStatusSchema', () => {
  it('should accept all valid statuses', () => {
    const statuses = [
      'pending',
      'queued',
      'extracting',
      'anonymizing',
      'loading',
      'completed',
      'failed',
      'skipped',
    ];
    for (const status of statuses) {
      expect(autopilotNodeStatusSchema.parse(status)).toBe(status);
    }
  });

  it('should reject invalid status', () => {
    expect(() => autopilotNodeStatusSchema.parse('invalid')).toThrow();
  });
});

describe('autopilotRelationshipTypeSchema', () => {
  it('should accept all valid relationship types', () => {
    const types = ['lookup', 'master_detail', 'hierarchical', 'polymorphic'];
    for (const t of types) {
      expect(autopilotRelationshipTypeSchema.parse(t)).toBe(t);
    }
  });

  it('should reject invalid relationship type', () => {
    expect(() => autopilotRelationshipTypeSchema.parse('self_join')).toThrow();
  });
});

describe('anonymizationMethodSchema', () => {
  it('should accept all valid methods', () => {
    const methods = [
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
    ];
    for (const m of methods) {
      expect(anonymizationMethodSchema.parse(m)).toBe(m);
    }
  });

  it('should reject invalid method', () => {
    expect(() => anonymizationMethodSchema.parse('encrypt')).toThrow();
  });
});

describe('piiCategorySchema', () => {
  it('should accept all valid categories', () => {
    const cats = ['PII', 'PHI', 'PCI', 'SENSITIVE', 'NONE'];
    for (const c of cats) {
      expect(piiCategorySchema.parse(c)).toBe(c);
    }
  });

  it('should reject invalid category', () => {
    expect(() => piiCategorySchema.parse('SECRET')).toThrow();
  });
});

describe('complianceFrameworkTypeSchema', () => {
  it('should accept all valid framework types', () => {
    const types = ['gdpr', 'ccpa', 'hipaa', 'pci_dss', 'custom', 'none'];
    for (const t of types) {
      expect(complianceFrameworkTypeSchema.parse(t)).toBe(t);
    }
  });

  it('should reject invalid framework', () => {
    expect(() => complianceFrameworkTypeSchema.parse('sox')).toThrow();
  });
});

// ─── Object Schema Tests ────────────────────────────────────────────────────

describe('piiFieldDetectionSchema', () => {
  it('should parse valid PII field detection', () => {
    const result = piiFieldDetectionSchema.parse(createValidPiiFieldDetection());
    expect(result.objectApiName).toBe('Contact');
    expect(result.confidence).toBe(0.95);
  });

  it('should reject confidence > 1', () => {
    expect(() =>
      piiFieldDetectionSchema.parse({ ...createValidPiiFieldDetection(), confidence: 1.5 }),
    ).toThrow();
  });

  it('should reject confidence < 0', () => {
    expect(() =>
      piiFieldDetectionSchema.parse({ ...createValidPiiFieldDetection(), confidence: -0.1 }),
    ).toThrow();
  });

  it('should reject missing fields', () => {
    expect(() => piiFieldDetectionSchema.parse({ objectApiName: 'Contact' })).toThrow();
  });
});

describe('anonymizationRuleSchema', () => {
  it('should parse valid rule', () => {
    const result = anonymizationRuleSchema.parse(createValidAnonymizationRule());
    expect(result.method).toBe('fake');
    expect(result.userOverridden).toBe(false);
  });

  it('should reject invalid method', () => {
    expect(() =>
      anonymizationRuleSchema.parse({ ...createValidAnonymizationRule(), method: 'encrypt' }),
    ).toThrow();
  });
});

describe('anonymizedPersonaSchema', () => {
  it('should parse valid persona', () => {
    const persona = {
      sourceRecordId: '003xx000001234AAA',
      firstName: 'Jane',
      lastName: 'Doe',
      email: 'jane.doe@example.com',
      phone: '+1-555-0100',
      address: '123 Fake St',
      city: 'Springfield',
      postalCode: '62701',
      company: 'Acme Corp',
    };
    const result = anonymizedPersonaSchema.parse(persona);
    expect(result.firstName).toBe('Jane');
  });

  it('should reject missing sourceRecordId', () => {
    expect(() =>
      anonymizedPersonaSchema.parse({
        firstName: 'Jane',
        lastName: 'Doe',
        email: 'jane@test.com',
        phone: '555',
        address: '123',
        city: 'NY',
        postalCode: '10001',
        company: 'X',
      }),
    ).toThrow();
  });
});

describe('autopilotNodeSchema', () => {
  it('should parse valid node', () => {
    const result = autopilotNodeSchema.parse(createValidAutopilotNode());
    expect(result.objectApiName).toBe('Account');
    expect(result.status).toBe('pending');
  });

  it('should parse node with nested PII fields and rules', () => {
    const node = {
      ...createValidAutopilotNode(),
      piiFields: [createValidPiiFieldDetection()],
      anonymizationRules: [createValidAnonymizationRule()],
    };
    const result = autopilotNodeSchema.parse(node);
    expect(result.piiFields).toHaveLength(1);
    expect(result.anonymizationRules).toHaveLength(1);
  });

  it('should reject progress > 100', () => {
    expect(() =>
      autopilotNodeSchema.parse({ ...createValidAutopilotNode(), progress: 150 }),
    ).toThrow();
  });

  it('should reject negative recordCount', () => {
    expect(() =>
      autopilotNodeSchema.parse({ ...createValidAutopilotNode(), recordCount: -1 }),
    ).toThrow();
  });
});

describe('autopilotEdgeSchema', () => {
  it('should parse valid edge', () => {
    const result = autopilotEdgeSchema.parse(createValidAutopilotEdge());
    expect(result.from).toBe('Account');
    expect(result.relationshipType).toBe('lookup');
  });

  it('should reject empty from', () => {
    expect(() => autopilotEdgeSchema.parse({ ...createValidAutopilotEdge(), from: '' })).toThrow();
  });
});

describe('cycleResolutionSchema', () => {
  it('should parse valid cycle resolution', () => {
    const result = cycleResolutionSchema.parse(createValidCycleResolution());
    expect(result.strategy).toBe('two_pass');
    expect(result.objects).toHaveLength(2);
  });

  it('should reject cycle with fewer than 2 objects', () => {
    expect(() =>
      cycleResolutionSchema.parse({ ...createValidCycleResolution(), objects: ['Account'] }),
    ).toThrow();
  });
});

describe('graphStatsSchema', () => {
  it('should parse valid stats', () => {
    const result = graphStatsSchema.parse(createValidGraphStats());
    expect(result.totalObjects).toBe(2);
  });

  it('should reject negative values', () => {
    expect(() =>
      graphStatsSchema.parse({ ...createValidGraphStats(), totalObjects: -1 }),
    ).toThrow();
  });
});

describe('autopilotGraphSchema', () => {
  it('should parse valid graph', () => {
    const graph = {
      nodes: [createValidAutopilotNode()],
      edges: [createValidAutopilotEdge()],
      cycles: [],
      stats: createValidGraphStats(),
    };
    const result = autopilotGraphSchema.parse(graph);
    expect(result.nodes).toHaveLength(1);
    expect(result.edges).toHaveLength(1);
  });

  it('should reject invalid nested node', () => {
    const graph = {
      nodes: [{ objectApiName: '' }],
      edges: [],
      cycles: [],
      stats: createValidGraphStats(),
    };
    expect(() => autopilotGraphSchema.parse(graph)).toThrow();
  });
});

describe('executionWaveSchema', () => {
  it('should parse valid wave', () => {
    const wave = { order: 0, objects: ['Account'], dependsOn: [] };
    const result = executionWaveSchema.parse(wave);
    expect(result.order).toBe(0);
  });

  it('should reject negative order', () => {
    expect(() =>
      executionWaveSchema.parse({ order: -1, objects: ['Account'], dependsOn: [] }),
    ).toThrow();
  });
});

describe('executionPlanSchema', () => {
  it('should parse valid execution plan', () => {
    const plan = {
      waves: [{ order: 0, objects: ['Account'], dependsOn: [] }],
      totalRecords: 100,
      estimatedDurationSec: 30,
      estimatedApiCalls: 5,
      complianceFramework: 'gdpr',
      anonymizationSummary: {
        totalPiiFields: 3,
        totalFieldsToAnonymize: 3,
        methodBreakdown: { fake: 2, mask: 1 },
        objectsWithPii: ['Contact'],
      },
      cycleResolutions: [],
    };
    const result = executionPlanSchema.parse(plan);
    expect(result.complianceFramework).toBe('gdpr');
    expect(result.waves).toHaveLength(1);
  });

  it('should reject invalid compliance framework', () => {
    expect(() =>
      executionPlanSchema.parse({
        waves: [],
        totalRecords: 0,
        estimatedDurationSec: 0,
        estimatedApiCalls: 0,
        complianceFramework: 'sox',
        anonymizationSummary: {
          totalPiiFields: 0,
          totalFieldsToAnonymize: 0,
          methodBreakdown: {},
          objectsWithPii: [],
        },
        cycleResolutions: [],
      }),
    ).toThrow();
  });
});

describe('autopilotConfigSchema', () => {
  it('should parse valid config', () => {
    const config = {
      sourceOrgId: 'org-source-123',
      targetOrgId: 'org-target-456',
      selectedObjects: ['Account', 'Contact'],
      complianceFramework: 'gdpr',
      maxRecordsPerObject: 1000,
      objectFilters: { Account: "Industry = 'Tech'" },
      includeStandardObjects: true,
      grappeThreshold: 5000,
    };
    const result = autopilotConfigSchema.parse(config);
    expect(result.sourceOrgId).toBe('org-source-123');
    expect(result.selectedObjects).toHaveLength(2);
  });

  it('should reject empty sourceOrgId', () => {
    expect(() =>
      autopilotConfigSchema.parse({
        sourceOrgId: '',
        targetOrgId: 'org-456',
        selectedObjects: [],
        complianceFramework: 'none',
        maxRecordsPerObject: 0,
        objectFilters: {},
        includeStandardObjects: false,
        grappeThreshold: 1000,
      }),
    ).toThrow();
  });

  it('should reject grappeThreshold of 0', () => {
    expect(() =>
      autopilotConfigSchema.parse({
        sourceOrgId: 'org-123',
        targetOrgId: 'org-456',
        selectedObjects: [],
        complianceFramework: 'none',
        maxRecordsPerObject: 0,
        objectFilters: {},
        includeStandardObjects: false,
        grappeThreshold: 0,
      }),
    ).toThrow();
  });
});

// ─── Discriminated Union Event Tests ─────────────────────────────────────────

describe('autopilotEventSchema', () => {
  const timestamp = '2026-03-07T12:00:00.000Z';

  it('should parse a simple scan-started event', () => {
    const event = { type: 'scan-started', timestamp };
    const result = autopilotEventSchema.parse(event);
    expect(result.type).toBe('scan-started');
  });

  it('should parse a simple execution-completed event', () => {
    const event = { type: 'execution-completed', timestamp };
    const result = autopilotEventSchema.parse(event);
    expect(result.type).toBe('execution-completed');
  });

  it('should parse a paused event', () => {
    const event = { type: 'paused', timestamp };
    const result = autopilotEventSchema.parse(event);
    expect(result.type).toBe('paused');
  });

  it('should parse a node-progress event with payload', () => {
    const event = {
      type: 'node-progress',
      timestamp,
      objectApiName: 'Account',
      progress: 50,
      recordsProcessed: 50,
      recordsTotal: 100,
      apiCallsUsed: 3,
    };
    const result = autopilotEventSchema.parse(event);
    expect(result.type).toBe('node-progress');
    if (result.type === 'node-progress') {
      expect(result.progress).toBe(50);
      expect(result.objectApiName).toBe('Account');
    }
  });

  it('should parse a node-completed event with payload', () => {
    const event = {
      type: 'node-completed',
      timestamp,
      objectApiName: 'Contact',
      successCount: 95,
      failureCount: 5,
      elapsedMs: 1200,
      apiCallsUsed: 4,
    };
    const result = autopilotEventSchema.parse(event);
    expect(result.type).toBe('node-completed');
    if (result.type === 'node-completed') {
      expect(result.successCount).toBe(95);
    }
  });

  it('should parse a node-failed event with payload', () => {
    const event = {
      type: 'node-failed',
      timestamp,
      objectApiName: 'Lead',
      errors: ['UNABLE_TO_LOCK_ROW', 'FIELD_INTEGRITY_EXCEPTION'],
      partialSuccessCount: 10,
    };
    const result = autopilotEventSchema.parse(event);
    expect(result.type).toBe('node-failed');
    if (result.type === 'node-failed') {
      expect(result.errors).toHaveLength(2);
    }
  });

  it('should reject node-progress event missing required fields', () => {
    expect(() =>
      autopilotEventSchema.parse({
        type: 'node-progress',
        timestamp,
        objectApiName: 'Account',
        // missing progress, recordsProcessed, recordsTotal, apiCallsUsed
      }),
    ).toThrow();
  });

  it('should reject unknown event type', () => {
    expect(() => autopilotEventSchema.parse({ type: 'unknown-event', timestamp })).toThrow();
  });
});
