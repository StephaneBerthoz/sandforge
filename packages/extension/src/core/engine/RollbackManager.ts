import { extractErrorMessage } from '../common/extractErrorMessage.js';
/** Status of a rollback operation */
export type RollbackStatus = 'pending' | 'rolling_back' | 'completed' | 'failed';

/** A savepoint capturing state before an operation */
export interface Savepoint {
  id: string;
  operationId: string;
  objectName: string;
  recordIds: string[];
  createdAt: string;
  status: RollbackStatus;
}

/** Result of a rollback operation */
export interface RollbackResult {
  savepointId: string;
  status: RollbackStatus;
  rolledBackCount: number;
  failedCount: number;
  errors: string[];
}

/** Function that performs the actual rollback of records */
export type RollbackExecutor = (
  objectName: string,
  recordIds: string[]
) => Promise<{ success: string[]; failed: Array<{ id: string; error: string }> }>;

/**
 * Manages transactional rollback with savepoints.
 * Tracks savepoints per operation and delegates actual rollback to an executor.
 */
export class RollbackManager {
  private savepoints: Map<string, Savepoint> = new Map();
  private operationIndex: Map<string, Set<string>> = new Map();
  private nextId = 0;

  /** Create a savepoint for an operation */
  createSavepoint(
    operationId: string,
    objectName: string,
    recordIds: string[]
  ): Savepoint {
    const id = `sp-${this.nextId++}`;
    const savepoint: Savepoint = {
      id,
      operationId,
      objectName,
      recordIds: [...recordIds],
      createdAt: new Date().toISOString(),
      status: 'pending',
    };

    this.savepoints.set(id, savepoint);

    let opSet = this.operationIndex.get(operationId);
    if (!opSet) {
      opSet = new Set();
      this.operationIndex.set(operationId, opSet);
    }
    opSet.add(id);

    return savepoint;
  }

  /** Rollback to a savepoint using the provided executor */
  async rollback(
    savepoint: Savepoint,
    executor: RollbackExecutor
  ): Promise<RollbackResult> {
    const tracked = this.savepoints.get(savepoint.id);
    if (!tracked) {
      return {
        savepointId: savepoint.id,
        status: 'failed',
        rolledBackCount: 0,
        failedCount: 0,
        errors: [`Savepoint ${savepoint.id} not found`],
      };
    }

    tracked.status = 'rolling_back';

    try {
      const result = await executor(tracked.objectName, tracked.recordIds);
      const errors = result.failed.map((f) => `${f.id}: ${f.error}`);

      if (result.failed.length === 0) {
        tracked.status = 'completed';
      } else if (result.success.length === 0) {
        tracked.status = 'failed';
      } else {
        tracked.status = 'completed';
      }

      return {
        savepointId: tracked.id,
        status: tracked.status,
        rolledBackCount: result.success.length,
        failedCount: result.failed.length,
        errors,
      };
    } catch (err: unknown) {
      tracked.status = 'failed';
      const message = extractErrorMessage(err);
      return {
        savepointId: tracked.id,
        status: 'failed',
        rolledBackCount: 0,
        failedCount: tracked.recordIds.length,
        errors: [message],
      };
    }
  }

  /** Get all savepoints for an operation */
  getSavepoints(operationId: string): Savepoint[] {
    const opSet = this.operationIndex.get(operationId);
    if (!opSet) return [];

    const result: Savepoint[] = [];
    for (const id of opSet) {
      const sp = this.savepoints.get(id);
      if (sp) result.push(sp);
    }
    return result;
  }

  /** Get a savepoint by ID */
  getSavepoint(savepointId: string): Savepoint | undefined {
    return this.savepoints.get(savepointId);
  }

  /** Clear all savepoints for an operation */
  clear(operationId: string): void {
    const opSet = this.operationIndex.get(operationId);
    if (!opSet) return;

    for (const id of opSet) {
      this.savepoints.delete(id);
    }
    this.operationIndex.delete(operationId);
  }

  /** Clear all savepoints */
  clearAll(): void {
    this.savepoints.clear();
    this.operationIndex.clear();
  }

  /** Get total number of savepoints */
  get totalSavepoints(): number {
    return this.savepoints.size;
  }
}
