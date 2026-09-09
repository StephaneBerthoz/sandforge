/**
 * Response factories for common extension→webview message patterns.
 *
 * Each factory builds a payload matching the shapes defined in
 * packages/shared/src/types/messages.types.ts.
 */

import type { MockOrg } from './mock-orgs';

/** Build an org:list:response payload. */
export function createOrgListResponse(orgs: MockOrg[]): { orgs: MockOrg[] } {
  return { orgs };
}

/** Build a forge:preview:response payload with field data. */
export function createPreviewResponse(
  objectApiName: string,
  fields: Array<{ name: string; value: string }>,
  recordId?: string,
): {
  objectApiName: string;
  objectLabel: string;
  recordId: string;
  fields: Array<{ name: string; value: string }>;
} {
  return {
    objectApiName,
    objectLabel: objectApiName,
    recordId: recordId ?? `001000000000001AAA`,
    fields,
  };
}

/** Build a describe response for object metadata. */
export function createDescribeResponse(
  objectApiName: string,
  fields: Array<{
    name: string;
    type: string;
    label: string;
    nillable?: boolean;
    updateable?: boolean;
  }>,
): {
  objectApiName: string;
  label: string;
  fields: Array<{
    name: string;
    type: string;
    label: string;
    nillable: boolean;
    updateable: boolean;
  }>;
} {
  return {
    objectApiName,
    label: objectApiName,
    fields: fields.map((f) => ({
      nillable: true,
      updateable: true,
      ...f,
    })),
  };
}

/** Standard Account fields for describe mocks. */
export const ACCOUNT_DESCRIBE_FIELDS = [
  { name: 'Id', type: 'id', label: 'Account ID' },
  { name: 'Name', type: 'string', label: 'Account Name' },
  { name: 'Type', type: 'picklist', label: 'Account Type' },
  { name: 'Industry', type: 'picklist', label: 'Industry' },
  { name: 'OwnerId', type: 'reference', label: 'Owner ID' },
  { name: 'ParentId', type: 'reference', label: 'Parent Account ID' },
];

/** Standard Contact fields for describe mocks. */
export const CONTACT_DESCRIBE_FIELDS = [
  { name: 'Id', type: 'id', label: 'Contact ID' },
  { name: 'FirstName', type: 'string', label: 'First Name' },
  { name: 'LastName', type: 'string', label: 'Last Name' },
  { name: 'Email', type: 'email', label: 'Email' },
  { name: 'Phone', type: 'phone', label: 'Phone' },
  { name: 'AccountId', type: 'reference', label: 'Account ID' },
];

/** Mock AI chat response payload. */
export function createAIChatResponse(
  conversationId: string,
  content: string,
): {
  conversationId: string;
  message: { id: string; role: string; content: string; timestamp: number };
} {
  return {
    conversationId,
    message: {
      id: `msg-${Date.now()}`,
      role: 'assistant',
      content,
      timestamp: Date.now(),
    },
  };
}

/** Mock AI NL2SOQL response payload. */
export function createNL2SOQLResponse(
  soql: string,
  explanation: string,
): { soql: string; explanation: string } {
  return { soql, explanation };
}

/** Mock AI error resolver response payload. */
export function createErrorResolverResponse(
  solutions: Array<{ title: string; description: string; code?: string }>,
): { solutions: Array<{ title: string; description: string; code?: string }> } {
  return { solutions };
}

/** Mock autopilot schema result payload. */
export function createSchemaResultResponse(
  objects: Array<{ apiName: string; label: string; recordCount: number }>,
): { graph: { objects: Array<{ apiName: string; label: string; recordCount: number }> } } {
  return {
    graph: { objects },
  };
}

/** Mock autopilot plan ready payload. */
export function createPlanReadyResponse(objectCount: number): {
  plan: { objectCount: number; estimatedTime: string };
  graph: { objects: Array<{ apiName: string; status: string }> };
} {
  const objects = Array.from({ length: objectCount }, (_, i) => ({
    apiName: `Object${i + 1}__c`,
    status: 'pending',
  }));
  return {
    plan: { objectCount, estimatedTime: `${objectCount * 2}min` },
    graph: { objects },
  };
}

/** Mock autopilot node progress payload. */
export function createNodeProgressResponse(
  objectApiName: string,
  progress: number,
  recordsProcessed: number,
  recordsTotal: number,
): {
  objectApiName: string;
  status: string;
  progress: number;
  recordsProcessed: number;
  recordsTotal: number;
  apiCallsUsed: number;
  elapsedMs: number;
} {
  return {
    objectApiName,
    status: 'processing',
    progress,
    recordsProcessed,
    recordsTotal,
    apiCallsUsed: Math.floor(recordsProcessed / 200) + 1,
    elapsedMs: recordsProcessed * 10,
  };
}

/** Mock autopilot completed payload. */
export function createAutopilotCompletedResponse(
  totalRecords: number,
  failures: number,
): {
  totalRecords: number;
  totalSuccessCount: number;
  totalFailureCount: number;
  totalElapsedMs: number;
  totalApiCalls: number;
} {
  return {
    totalRecords,
    totalSuccessCount: totalRecords - failures,
    totalFailureCount: failures,
    totalElapsedMs: totalRecords * 10,
    totalApiCalls: Math.floor(totalRecords / 200) + 1,
  };
}

// ---------------------------------------------------------------------------
// Phase 02 / Plan 02-03 — 5 critical flow fixtures
// ---------------------------------------------------------------------------

/** Mock AI-generated Forge persona payload. */
export function mockAIPersona(): {
  id: string;
  name: string;
  description: string;
  recordCount: number;
  objects: string[];
} {
  return {
    id: 'persona-mid-b2b-saas',
    name: 'Mid-market B2B SaaS customer',
    description:
      'Realistic mid-market B2B SaaS customer persona with 50 records across Account, Contact and Opportunity.',
    recordCount: 50,
    objects: ['Account', 'Contact', 'Opportunity'],
  };
}

/** Mock sync conflict notification payload with 2 conflicting fields. */
export function mockSyncConflict(): {
  conflictId: string;
  objectApiName: 'Contact';
  recordId: string;
  fieldConflicts: Array<{ field: string; source: string; target: string }>;
} {
  return {
    conflictId: 'conflict-1',
    objectApiName: 'Contact',
    recordId: '003000000000001AAA',
    fieldConflicts: [
      { field: 'Email', source: 'alice@new.example.com', target: 'alice@old.example.com' },
      { field: 'Phone', source: '+33100000001', target: '+33100000000' },
    ],
  };
}

/** Mock CDC subscription response payload. */
export function mockCdcSubscription(): {
  subscriptionId: string;
  objectApiName: 'Account';
  replayId: number;
  allocationUsed: number;
  allocationMax: number;
} {
  return {
    subscriptionId: 'sub-1',
    objectApiName: 'Account',
    replayId: -1,
    allocationUsed: 5200,
    allocationMax: 100000,
  };
}

/** Mock CDC event payload indexed by sequence. */
export function mockCdcEvent(seq: number): {
  eventId: string;
  objectApiName: string;
  changeType: 'UPDATE';
  recordIds: string[];
  occurredAt: string;
} {
  return {
    eventId: `evt-${seq}`,
    objectApiName: 'Account',
    changeType: 'UPDATE',
    recordIds: [`001000000000${String(seq).padStart(3, '0')}AAA`],
    occurredAt: new Date(Date.now() + seq * 1000).toISOString(),
  };
}

/** Mock failed job payload used by the AI diagnose flow. */
export function mockFailedJob(): {
  jobId: string;
  objectApiName: string;
  status: 'Failed';
  errorMessage: string;
  failedRecords: number;
  totalRecords: number;
} {
  return {
    jobId: 'job-failed-1',
    objectApiName: 'Account',
    status: 'Failed',
    errorMessage: 'FIELD_CUSTOM_VALIDATION_EXCEPTION: Invalid region code',
    failedRecords: 12,
    totalRecords: 100,
  };
}

/** Mock AI diagnosis payload for a failed job. */
export function mockAIDiagnosis(): {
  diagnosisId: string;
  summary: string;
  proposedFix: {
    action: 'update-records';
    field: string;
    fromValue: string;
    toValue: string;
    affectedCount: number;
  };
  confidence: number;
} {
  return {
    diagnosisId: 'diag-1',
    summary:
      'The Region picklist rejected "EMEA-OLD" values; 12 Accounts need to be rewritten to "EMEA" to satisfy the custom validation rule.',
    proposedFix: {
      action: 'update-records',
      field: 'Region',
      fromValue: 'EMEA-OLD',
      toValue: 'EMEA',
      affectedCount: 12,
    },
    confidence: 0.88,
  };
}

/** Mock "fix applied" confirmation payload. */
export function mockFixApplied(): {
  diagnosisId: string;
  applied: true;
  updatedRecords: number;
} {
  return {
    diagnosisId: 'diag-1',
    applied: true,
    updatedRecords: 12,
  };
}
