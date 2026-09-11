import { sanitizeSoqlObjectName, DEFAULT_SOQL_LIMITS } from '@sandforge/shared';
import type { HandlerDeps, DomainHandler, InboundRequest } from '../HandlerTypes.js';
import { buildResponse } from '../HandlerTypes.js';
import {
  validatePayload,
  aiAnomalyScanPayloadSchema,
  aiSchemaAdvicePayloadSchema,
} from '../../validatePayload.js';
import type { RuleModules } from '../AIHandler.js';
import { extractErrorMessage } from '../../../core/common/extractErrorMessage.js';
import { getJsforceConnection } from '../../../core/connection/ConnectionHelper.js';
import { queryWithFieldsFallback } from '../../../core/common/soqlQueryHelper.js';

/** Message types handled by AIAnalysisHandler. */
const AI_ANALYSIS_TYPES = new Set(['ai:anomaly-scan', 'ai:schema-advice']);

/**
 * Sub-handler for the org analysis messages.
 *
 * Anomaly scanning and schema advice are rule engines — local heuristics over
 * a record sample or a describe, with no provider call — so they answer
 * whether or not AI is enabled. The `ai:` channel names are kept as-is: the
 * webview and the message contract already ship under them.
 */
export class AIAnalysisHandler implements DomainHandler {
  private ruleModules?: RuleModules;

  /** @param deps - Injected handler dependencies. */
  constructor(private readonly deps: HandlerDeps) {}

  /** Inject the rule-based analysis modules. */
  setRuleModules(modules: RuleModules): void {
    this.ruleModules = modules;
  }

  /**
   * Handle an incoming bridge message.
   *
   * @param msg - The typed base message from the webview.
   * @returns `true` if the message was handled, `false` otherwise.
   */
  async handle(msg: InboundRequest): Promise<boolean> {
    if (!AI_ANALYSIS_TYPES.has(msg.type)) return false;

    switch (msg.type) {
      case 'ai:anomaly-scan':
        await this.handleAnomalyScan(msg);
        return true;
      case 'ai:schema-advice':
        await this.handleSchemaAdvice(msg);
        return true;
      default:
        return false;
    }
  }

  private async handleAnomalyScan(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(aiAnomalyScanPayloadSchema, msg, 'ai:error', this.deps);
    if (!parsed) return;
    const { orgId, objectName, sampleSize } = parsed;
    try {
      if (!this.ruleModules?.anomalyDetector) {
        throw new Error('Anomaly scan is still starting up. Try again in a moment.');
      }
      const conn = await getJsforceConnection(orgId, this.deps.orgRegistry, this.deps.orgManager);
      const safeObj = sanitizeSoqlObjectName(objectName);
      const limit = sampleSize ?? DEFAULT_SOQL_LIMITS.anomalyScan;
      const soql = `SELECT FIELDS(ALL) FROM ${safeObj} LIMIT ${limit}`;
      const records = await queryWithFieldsFallback<Record<string, unknown>>(conn, safeObj, soql);
      const sample = { records, fields: Object.keys(records[0] ?? {}) };
      const report = this.ruleModules.anomalyDetector.detectAnomalies(sample, objectName);
      const response = buildResponse(this.deps, msg, 'ai:anomaly-scan:response', {
        success: true,
        anomalies: report.anomalies.map(
          (a: { field: string; type: string; description: string; severity: string }) => ({
            field: a.field,
            type: a.type,
            description: a.description,
            severity: a.severity,
          }),
        ),
      });
      this.deps.broker.postToWebview(response);
    } catch (err: unknown) {
      this.deps.log(`[ERR] ai:anomaly-scan: ${extractErrorMessage(err)}`);
      const errResp = buildResponse(this.deps, msg, 'ai:anomaly-scan:response', {
        success: false,
        error: extractErrorMessage(err),
      });
      this.deps.broker.postToWebview(errResp);
    }
  }

  private async handleSchemaAdvice(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(aiSchemaAdvicePayloadSchema, msg, 'ai:error', this.deps);
    if (!parsed) return;
    const { orgId, objectNames } = parsed;
    try {
      if (!this.ruleModules?.schemaAdvisor) {
        throw new Error('Schema advice is still starting up. Try again in a moment.');
      }
      const conn = await getJsforceConnection(orgId, this.deps.orgRegistry, this.deps.orgManager);
      const names = objectNames ?? ['Account', 'Contact', 'Lead', 'Opportunity'];
      const describes = await Promise.all(
        names.map(async (objName: string) => {
          const desc = await conn.describe(objName);
          return {
            apiName: desc.name as string,
            label: (desc as { label: string }).label,
            custom: (desc as { custom?: boolean }).custom ?? false,
            fields: (
              desc.fields as Array<{
                name: string;
                label: string;
                type: string;
                custom?: boolean;
                referenceTo?: string[];
              }>
            ).map(
              (f: {
                name: string;
                label: string;
                type: string;
                custom?: boolean;
                referenceTo?: string[];
              }) => ({
                apiName: f.name,
                label: f.label,
                type: f.type,
                required: false,
                custom: f.custom ?? false,
                referenceTo: f.referenceTo,
              }),
            ),
          };
        }),
      );
      const advice = this.ruleModules.schemaAdvisor.analyzeSchema(describes);
      const response = buildResponse(this.deps, msg, 'ai:schema-advice:response', {
        success: true,
        advice: {
          issues: advice.issues.map(
            (i: {
              objectName: string;
              fieldName?: string;
              severity: string;
              description: string;
            }) => ({
              objectName: i.objectName,
              field: i.fieldName,
              severity: i.severity,
              message: i.description,
            }),
          ),
          recommendations: advice.suggestions.map((r: { title: string; description: string }) => ({
            title: r.title,
            description: r.description,
          })),
        },
      });
      this.deps.broker.postToWebview(response);
    } catch (err: unknown) {
      this.deps.log(`[ERR] ai:schema-advice: ${extractErrorMessage(err)}`);
      const errResp = buildResponse(this.deps, msg, 'ai:schema-advice:response', {
        success: false,
        error: extractErrorMessage(err),
      });
      this.deps.broker.postToWebview(errResp);
    }
  }
}
