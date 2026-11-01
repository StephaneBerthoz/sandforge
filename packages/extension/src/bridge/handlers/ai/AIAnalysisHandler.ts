import { sanitizeSoqlObjectName, DEFAULT_SOQL_LIMITS } from '@sandforge/shared';
import type { HandlerDeps, DomainHandler, InboundRequest } from '../HandlerTypes.js';
import { buildResponse } from '../HandlerTypes.js';
import { validatePayload, aiAnomalyScanPayloadSchema } from '../../validatePayload.js';
import type { RuleModules } from '../AIHandler.js';
import { extractErrorMessage } from '../../../core/common/extractErrorMessage.js';
import { getJsforceConnection } from '../../../core/connection/ConnectionHelper.js';
import { queryWithFieldsFallbackBounded } from '../../../core/common/soqlQueryHelper.js';

/** Message types handled by AIAnalysisHandler. */
const AI_ANALYSIS_TYPES = new Set(['ai:anomaly-scan']);

/**
 * Sub-handler for the org analysis messages.
 *
 * Anomaly scanning is a rule engine — local heuristics over a record sample,
 * with no provider call — so it answers whether or not AI is enabled. The
 * `ai:` channel name is kept as-is: the webview and the message contract
 * already ship under it.
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
      const read = await queryWithFieldsFallbackBounded<Record<string, unknown>>(
        conn,
        safeObj,
        soql,
      );
      const records = read.records;
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
        // The scan judges a sample, and said nothing of it: "no anomalies"
        // read as a verdict on the object, over the first 500 rows it read.
        // The bound is the one the statement went out with, and the count is
        // what came back.
        sample: { read: records.length, limit: read.limit ?? limit },
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
}
