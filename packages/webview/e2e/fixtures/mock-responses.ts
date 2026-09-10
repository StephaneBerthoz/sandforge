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
