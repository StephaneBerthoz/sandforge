import type { CsvValidationResult, RobustnessConfig } from '@sandforge/shared';
import { orgTypeToGuardTier, RobustnessConfigSchema } from '@sandforge/shared';
import type { HandlerDeps, DomainHandler, InboundRequest } from './HandlerTypes.js';
import type { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';
import {
  buildResponse,
  sendHandlerError,
  sendOperationStarted,
  sendOperationProgress,
  sendOperationCompleted,
  sendOperationFailed,
} from './HandlerTypes.js';
import { validatePayload, seedCsvPayloadSchema } from '../validatePayload.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { checkApiLimits } from '../../core/common/sforceLimitParser.js';
import { CsvValidator } from '../../modules/seed/CsvValidator.js';
import type { DescribeField } from '../../modules/seed/SchemaAnalyzer.js';
import { BulkDataWriter } from '../../modules/sync/BulkDataWriter.js';
import { BulkApiExecutor } from '../../core/engine/BulkApiExecutor.js';
import { BulkApiManager } from '../../core/engine/BulkApiManager.js';

/** Message types handled by SeedCsvHandler. */
const SEED_CSV_TYPES = new Set(['seed:csv:validate', 'seed:csv:execute']);

/** Max error strings returned in the execute response (bounds postMessage size). */
const MAX_RESPONSE_ERRORS = 100;

/** Shape of the `seed:csv:execute:response` payload (see useCsvImport.CsvExecutionResult). */
interface CsvExecutionResultPayload {
  insertedCount: number;
  failedCount: number;
  errors: string[];
}

/**
 * Domain handler for the CSV import wizard (`seed:csv:*`).
 *
 * The webview pre-parses the file with PapaParse and posts typed rows, so the
 * extension validates against the live describe metadata (CsvValidator) and
 * writes through BulkDataWriter (REST batches / Bulk API with retry):
 *   seed:csv:validate -> seed:csv:validate:response (CsvValidationResult)
 *   seed:csv:execute  -> seed:csv:execute:response  { insertedCount, failedCount, errors }
 * Validation failures are reported on `seed:csv:error`; execute failures on
 * `operation:failed` (same convention as seed:execute / sync:execute).
 */
export class SeedCsvHandler implements DomainHandler {
  /** @param deps - Injected handler dependencies. */
  private registry?: BackgroundOperationRegistry;

  constructor(private readonly deps: HandlerDeps) {}

  /**
   * Inject the shared registry so CSV imports are cancellable.
   * Called from ExtensionHandlers, same as SeedOpsHandler.
   */
  setRegistry(registry: BackgroundOperationRegistry): void {
    this.registry = registry;
  }

  /**
   * Handle an incoming bridge message.
   *
   * @param msg - The typed base message from the webview.
   * @returns `true` if the message was handled, `false` otherwise.
   */
  async handle(msg: InboundRequest): Promise<boolean> {
    if (!SEED_CSV_TYPES.has(msg.type)) return false;

    switch (msg.type) {
      case 'seed:csv:validate':
        await this.handleValidate(msg);
        return true;
      case 'seed:csv:execute':
        await this.handleExecute(msg);
        return true;
      default:
        return false;
    }
  }

  /** Load robustness configuration (retry/timeout/bulk thresholds) from ConfigStore. */
  private getRobustnessConfig(): RobustnessConfig {
    const raw = this.deps.configStore.get<Partial<RobustnessConfig>>('robustness:config');
    return RobustnessConfigSchema.parse(raw ?? {});
  }

  /** Validate mapped CSV rows against the target object's live describe metadata. */
  private async handleValidate(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(seedCsvPayloadSchema, msg, 'seed:csv:error', this.deps);
    if (!parsed) return;

    try {
      const conn = await getJsforceConnection(
        parsed.orgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );
      const describe = await conn.describe(parsed.objectApiName);
      checkApiLimits(conn.limitInfo, `seed:csv:validate describe ${parsed.objectApiName}`);

      const validator = new CsvValidator();
      const result: CsvValidationResult = validator.validate(
        parsed.records,
        parsed.columnMappings,
        describe.fields as unknown as DescribeField[],
        parsed.externalIdField,
      );

      const response = buildResponse(
        this.deps,
        msg,
        'seed:csv:validate:response',
        result as unknown as Record<string, unknown>,
      );
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id} valid=${result.valid}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'seed:csv:validate', 'seed:csv:error', msg, err);
    }
  }

  /** Import mapped CSV rows into the target org via BulkDataWriter. */
  private async handleExecute(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(seedCsvPayloadSchema, msg, 'seed:csv:error', this.deps);
    if (!parsed) return;
    const operationId = msg.id;

    // A throwaway `new AbortController()` was handed to BulkDataWriter, so its
    // signal could never fire and the import was never registered —
    // execution:abort answered "Operation not found" and the load ran on.
    const abortController = new AbortController();
    let settle: (err?: unknown) => void = () => {};
    const tracked = new Promise<void>((resolve, reject) => {
      settle = (err) => (err === undefined ? resolve() : reject(err));
    });
    // The registry attaches its own handlers; this only prevents an unhandled
    // rejection when no registry has been injected.
    tracked.catch(() => {});
    this.registry?.register(operationId, 'csv', 'CSV import', tracked, abortController);

    try {
      // Production guard check on target org (mirror SyncOpsHandler).
      if (this.deps.infraServices?.productionGuard) {
        const guard = this.deps.infraServices.productionGuard;
        const targetOrg = this.deps.orgManager.getOrg(parsed.orgId);
        const guardRequest = {
          orgId: parsed.orgId,
          orgTier: orgTypeToGuardTier(targetOrg?.orgType ?? ''),
          operation: (parsed.externalIdField ? 'upsert' : 'insert') as 'upsert' | 'insert',
          objectName: parsed.objectApiName,
          recordCount: parsed.records.length,
          module: 'seed',
        };
        const check = guard.check(guardRequest);
        guard.logOperation(guardRequest, check);
        if (!check.allowed) {
          throw new Error(
            `Operation blocked by Production Guard: ${check.blockedReason ?? check.impactSummary}`,
          );
        }
        const confirmed = await guard.confirmIfNeeded(check);
        if (!confirmed) {
          sendOperationFailed(
            this.deps,
            operationId,
            'Operation cancelled by user (production confirmation declined).',
            false,
          );
          return;
        }
      }

      const conn = await getJsforceConnection(
        parsed.orgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );

      sendOperationStarted(
        this.deps,
        operationId,
        'seed',
        `CSV import ${parsed.records.length} record(s) into ${parsed.objectApiName}`,
      );

      const robustnessConfig = this.getRobustnessConfig();
      const defaultBatchSize =
        this.deps.services?.getSandforgeSetting?.('seed.defaultBatchSize', 200) ?? 200;
      const writer = new BulkDataWriter({
        connection: conn,
        bulkExecutor: new BulkApiExecutor(robustnessConfig.bulk.threshold),
        bulkManager: new BulkApiManager(robustnessConfig.bulk.maxConcurrentJobs),
        retryConfig: robustnessConfig.retry,
        describeTimeoutMs: robustnessConfig.timeouts.describe,
        signal: abortController.signal,
        onProgress: (processed, total, label) => {
          sendOperationProgress(
            this.deps,
            operationId,
            total > 0 ? Math.round((processed / total) * 100) : 0,
            processed,
            total,
            label,
          );
        },
        log: (message) => this.deps.log(message),
      });

      const writeRecords = parsed.records.map((row) =>
        buildSalesforceRecord(row, parsed.columnMappings),
      );

      const outcomes = parsed.externalIdField
        ? await writer.upsert(
            parsed.objectApiName,
            parsed.externalIdField,
            writeRecords,
            defaultBatchSize,
          )
        : await writer.insert(parsed.objectApiName, writeRecords, defaultBatchSize);

      const errors: string[] = [];
      let insertedCount = 0;
      for (const outcome of outcomes) {
        if (outcome.success) {
          insertedCount++;
        } else if (errors.length < MAX_RESPONSE_ERRORS) {
          errors.push(outcome.errors[0] ?? 'Unknown insert error');
        }
      }
      const failedCount = outcomes.length - insertedCount;

      const payload: CsvExecutionResultPayload = { insertedCount, failedCount, errors };
      sendOperationCompleted(this.deps, operationId, { insertedCount, failedCount });
      const response = buildResponse(
        this.deps,
        msg,
        'seed:csv:execute:response',
        payload as unknown as Record<string, unknown>,
      );
      this.deps.broker.postToWebview(response);
      this.deps.log(
        `[TX] ${response.type} id=${response.id} inserted=${insertedCount} failed=${failedCount}`,
      );
      settle();
    } catch (err: unknown) {
      // Single failure emission: `operation:failed` only (same convention as
      // seed:execute / sync:execute — the webview consumes that channel).
      this.deps.log(`[ERR] seed:csv:execute: ${extractErrorMessage(err)}`);
      sendOperationFailed(this.deps, operationId, extractErrorMessage(err), true);
      settle(err);
    }
  }
}

/**
 * Build a Salesforce record from a CSV row using the column mappings.
 * Unmapped columns (empty `sfFieldApiName`) and empty cells are skipped so
 * Salesforce defaults/required-field validation apply. Cell values are
 * coerced by {@link coerceCellValue} ('true'/'false'/'null'/numeric strings)
 * so REST writes get proper JSON primitives.
 */
function buildSalesforceRecord(
  row: Record<string, string>,
  columnMappings: Array<{ csvHeader: string; sfFieldApiName: string }>,
): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const mapping of columnMappings) {
    if (!mapping.sfFieldApiName) continue;
    const value = row[mapping.csvHeader];
    if (value === undefined || value === '') continue;
    record[mapping.sfFieldApiName] = coerceCellValue(value);
  }
  return record;
}

/** Coerce a CSV cell string to a JSON primitive. */
function coerceCellValue(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  const num = Number(value);
  if (!Number.isNaN(num) && value.trim() !== '') return num;
  return value;
}
