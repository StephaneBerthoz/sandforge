/**
 * 10 read-only tool builders.
 *
 * Each builder takes a generic `ToolDeps` and returns a `WrappedTool`. The
 * deps interface is intentionally minimal — the consume site (Plan 04-04
 * AIDiagnoseHandler) wires it to real SalesforceAdapter / MonitorOrchestrator
 * surfaces. Tests inject mock deps.
 *
 * Plan 04-03 explicitly: tool naming + Zod I/O contracts are the must-haves;
 * actual SF/Monitor wiring lives at the consume site.
 */
import type { z } from 'zod';

import {
  describeObjectInput,
  describeObjectOutput,
  queryRecordsInput,
  queryRecordsOutput,
  getLimitsInput,
  getLimitsOutput,
  getRecentErrorsInput,
  getRecentErrorsOutput,
  getApexLogInput,
  getApexLogOutput,
  getMetadataInput,
  getMetadataOutput,
  getAlertsInput,
  getAlertsOutput,
  getAnomaliesInput,
  getAnomaliesOutput,
  listSObjectsInput,
  listSObjectsOutput,
  validateSoqlInput,
  validateSoqlOutput,
} from '@sandforge/shared';

import { wrapTool, type ToolTraceFn, type WrappedTool } from './wrapTool.js';

// ── Generic deps interface — consume sites stub or wire as needed ──────────

export interface ToolDeps {
  orgId: string;
  onTrace?: ToolTraceFn;
  /** Optional adapters injected by the consume site. */
  describe?: (sObject: string) => Promise<z.infer<typeof describeObjectOutput>>;
  query?: (soql: string, limit: number) => Promise<z.infer<typeof queryRecordsOutput>>;
  getLimits?: () => Promise<z.infer<typeof getLimitsOutput>>;
  getRecentErrors?: (
    args: z.infer<typeof getRecentErrorsInput>,
  ) => Promise<z.infer<typeof getRecentErrorsOutput>>;
  getApexLog?: (logId: string) => Promise<z.infer<typeof getApexLogOutput>>;
  getMetadata?: (
    args: z.infer<typeof getMetadataInput>,
  ) => Promise<z.infer<typeof getMetadataOutput>>;
  getAlerts?: (orgId: string) => Promise<z.infer<typeof getAlertsOutput>>;
  getAnomalies?: (
    args: z.infer<typeof getAnomaliesInput>,
  ) => Promise<z.infer<typeof getAnomaliesOutput>>;
  listSObjects?: (
    args: z.infer<typeof listSObjectsInput>,
  ) => Promise<z.infer<typeof listSObjectsOutput>>;
  validateSoql?: (soql: string) => Promise<z.infer<typeof validateSoqlOutput>>;
}

const DML_REGEX = /\b(INSERT|UPDATE|DELETE|UPSERT|MERGE|UNDELETE)\s/i;

function notWired(toolName: string): never {
  throw new Error(`${toolName} not wired — consume site must inject the dep.`);
}

// ── 1. describe_object ──────────────────────────────────────────────────────

export function buildDescribeObjectTool(
  deps: ToolDeps,
): WrappedTool<typeof describeObjectInput, typeof describeObjectOutput> {
  return wrapTool({
    name: 'describe_object',
    description: 'Describe a Salesforce sObject — returns label, fields, recordTypeIds. READ-ONLY.',
    input: describeObjectInput,
    output: describeObjectOutput,
    onTrace: deps.onTrace,
    run: async ({ sObject }) => {
      if (!deps.describe) notWired('describe_object');
      return deps.describe(sObject);
    },
  });
}

// ── 2. query_records ────────────────────────────────────────────────────────

export function buildQueryRecordsTool(
  deps: ToolDeps,
): WrappedTool<typeof queryRecordsInput, typeof queryRecordsOutput> {
  return wrapTool({
    name: 'query_records',
    description: 'Run a read-only SOQL query (SELECT only). READ-ONLY.',
    input: queryRecordsInput,
    output: queryRecordsOutput,
    onTrace: deps.onTrace,
    run: async ({ soql, limit }) => {
      // Block any DML keyword smuggled into a SELECT — defense in depth even
      // though the validate_soql tool also guards.
      if (DML_REGEX.test(soql)) {
        const err = new Error('DML keywords are not allowed in query_records');
        (err as Error & { code?: string }).code = 'DML_FORBIDDEN';
        throw err;
      }
      if (!deps.query) notWired('query_records');
      return deps.query(soql, limit);
    },
  });
}

// ── 3. get_limits ───────────────────────────────────────────────────────────

export function buildGetLimitsTool(
  deps: ToolDeps,
): WrappedTool<typeof getLimitsInput, typeof getLimitsOutput> {
  return wrapTool({
    name: 'get_limits',
    description: 'Read the org-wide governor limits snapshot. READ-ONLY.',
    input: getLimitsInput,
    output: getLimitsOutput,
    onTrace: deps.onTrace,
    run: async () => {
      if (!deps.getLimits) notWired('get_limits');
      return deps.getLimits();
    },
  });
}

// ── 4. get_recent_errors ────────────────────────────────────────────────────

export function buildGetRecentErrorsTool(
  deps: ToolDeps,
): WrappedTool<typeof getRecentErrorsInput, typeof getRecentErrorsOutput> {
  return wrapTool({
    name: 'get_recent_errors',
    description: 'List recent classified errors (apex / sync / job). READ-ONLY.',
    input: getRecentErrorsInput,
    output: getRecentErrorsOutput,
    onTrace: deps.onTrace,
    run: async (args) => {
      if (!deps.getRecentErrors) notWired('get_recent_errors');
      return deps.getRecentErrors(args);
    },
  });
}

// ── 5. get_apex_log ─────────────────────────────────────────────────────────

export function buildGetApexLogTool(
  deps: ToolDeps,
): WrappedTool<typeof getApexLogInput, typeof getApexLogOutput> {
  return wrapTool({
    name: 'get_apex_log',
    description: 'Fetch a single ApexLog body, truncated at 50 KB. READ-ONLY.',
    input: getApexLogInput,
    output: getApexLogOutput,
    onTrace: deps.onTrace,
    run: async ({ logId }) => {
      if (!deps.getApexLog) notWired('get_apex_log');
      return deps.getApexLog(logId);
    },
  });
}

// ── 6. get_metadata ─────────────────────────────────────────────────────────

export function buildGetMetadataTool(
  deps: ToolDeps,
): WrappedTool<typeof getMetadataInput, typeof getMetadataOutput> {
  return wrapTool({
    name: 'get_metadata',
    description: 'Fetch a metadata definition by type + fullName. READ-ONLY.',
    input: getMetadataInput,
    output: getMetadataOutput,
    onTrace: deps.onTrace,
    run: async (args) => {
      if (!deps.getMetadata) notWired('get_metadata');
      return deps.getMetadata(args);
    },
  });
}

// ── 7. get_alerts ───────────────────────────────────────────────────────────

export function buildGetAlertsTool(
  deps: ToolDeps,
): WrappedTool<typeof getAlertsInput, typeof getAlertsOutput> {
  return wrapTool({
    name: 'get_alerts',
    description: 'List open AlertEngine instances for the org. READ-ONLY.',
    input: getAlertsInput,
    output: getAlertsOutput,
    onTrace: deps.onTrace,
    run: async ({ orgId }) => {
      if (!deps.getAlerts) notWired('get_alerts');
      return deps.getAlerts(orgId);
    },
  });
}

// ── 8. get_anomalies ────────────────────────────────────────────────────────

export function buildGetAnomaliesTool(
  deps: ToolDeps,
): WrappedTool<typeof getAnomaliesInput, typeof getAnomaliesOutput> {
  return wrapTool({
    name: 'get_anomalies',
    description: 'Read AnomalyEngine detections for the org. READ-ONLY.',
    input: getAnomaliesInput,
    output: getAnomaliesOutput,
    onTrace: deps.onTrace,
    run: async (args) => {
      if (!deps.getAnomalies) notWired('get_anomalies');
      return deps.getAnomalies(args);
    },
  });
}

// ── 9. list_sobjects ────────────────────────────────────────────────────────

export function buildListSObjectsTool(
  deps: ToolDeps,
): WrappedTool<typeof listSObjectsInput, typeof listSObjectsOutput> {
  return wrapTool({
    name: 'list_sobjects',
    description: 'List sObjects accessible in the org (filter custom/standard/all). READ-ONLY.',
    input: listSObjectsInput,
    output: listSObjectsOutput,
    onTrace: deps.onTrace,
    run: async (args) => {
      if (!deps.listSObjects) notWired('list_sobjects');
      return deps.listSObjects(args);
    },
  });
}

// ── 10. validate_soql ───────────────────────────────────────────────────────

export function buildValidateSoqlTool(
  deps: ToolDeps,
): WrappedTool<typeof validateSoqlInput, typeof validateSoqlOutput> {
  return wrapTool({
    name: 'validate_soql',
    description: 'Validate SOQL syntax + flag anti-patterns. Refuses DML. READ-ONLY.',
    input: validateSoqlInput,
    output: validateSoqlOutput,
    onTrace: deps.onTrace,
    run: async ({ soql }) => {
      if (DML_REGEX.test(soql)) {
        const err = new Error('DML keywords are not allowed in SOQL — refuse');
        (err as Error & { code?: string }).code = 'DML_FORBIDDEN';
        throw err;
      }
      if (!deps.validateSoql) notWired('validate_soql');
      return deps.validateSoql(soql);
    },
  });
}

// ── Registry ─────────────────────────────────────────────────────────────────

export const READ_ONLY_TOOL_NAMES = [
  'describe_object',
  'query_records',
  'get_limits',
  'get_recent_errors',
  'get_apex_log',
  'get_metadata',
  'get_alerts',
  'get_anomalies',
  'list_sobjects',
  'validate_soql',
] as const;
export type ReadOnlyToolName = (typeof READ_ONLY_TOOL_NAMES)[number];

export function buildAllReadOnlyTools(deps: ToolDeps): WrappedTool<z.ZodTypeAny, z.ZodTypeAny>[] {
  return [
    buildDescribeObjectTool(deps),
    buildQueryRecordsTool(deps),
    buildGetLimitsTool(deps),
    buildGetRecentErrorsTool(deps),
    buildGetApexLogTool(deps),
    buildGetMetadataTool(deps),
    buildGetAlertsTool(deps),
    buildGetAnomaliesTool(deps),
    buildListSObjectsTool(deps),
    buildValidateSoqlTool(deps),
  ];
}
