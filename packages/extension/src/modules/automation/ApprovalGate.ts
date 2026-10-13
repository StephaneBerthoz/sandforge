import type { PipelineApprovalChannel, PipelineApprovalRecord } from '@sandforge/shared';

/** What an Approval step asks, and how long it waits for the answer. */
export interface ApprovalRequest {
  /** The run's operation id: the page's request id, or a trigger's. */
  operationId: string;
  stepId: string;
  stepName: string;
  pipelineName?: string;
  /** What the step says with its question; absent, it asks with the names alone. */
  message?: string;
  /** How long it waits for an answer, in milliseconds. */
  timeoutMs: number;
}

/** What the question shows: the request, and when it stops waiting. */
export interface ApprovalQuestion extends ApprovalRequest {
  expiresAt: string;
}

/** What the gate needs from the window. */
export interface ApprovalGateDeps {
  /**
   * Shows the question in the VS Code window, with Approve and Reject, and
   * resolves with the button pressed — or undefined when it was closed
   * without one. Absent where there is no window to show it in.
   */
  ask?: (question: ApprovalQuestion) => Promise<'approve' | 'reject' | undefined>;
  /** Tells the page the step waits, and until when: it offers the same choice beside the step. */
  announce?: (question: ApprovalQuestion) => void;
  /** Tells the person who pressed a button on a question that no longer waits. */
  tooLate?: (question: ApprovalQuestion) => void;
  /** Who answers in this window, as a hash (see `PipelineApprovalRecord.by`). */
  who?: () => string | undefined;
  /** The clock, for tests. */
  now?: () => Date;
}

/** A question waiting for its answer. */
interface Waiting {
  question: ApprovalQuestion;
  settle: (record: PipelineApprovalRecord) => void;
}

/** The key of a waiting question: the run, and the step in it. */
function keyOf(operationId: string, stepId: string): string {
  return `${operationId}\u0000${stepId}`;
}

/**
 * Holds a pipeline's Approval steps until someone answers them.
 *
 * A step is answered once, by whichever comes first: Approve or Reject on the
 * VS Code notification or beside the step on the Automation page, the end of
 * its wait, or the cancel of its run. Whatever comes after that changes
 * nothing: the run has gone on, or stopped, on the first.
 *
 * A notification cannot be taken back once shown. One answered on the page,
 * or left until the wait ended, stays in VS Code's notification list, and a
 * button pressed on it later is told the question no longer waits rather than
 * read as an answer.
 */
export class ApprovalGate {
  private readonly waiting = new Map<string, Waiting>();

  constructor(private readonly deps: ApprovalGateDeps) {}

  /** Whether the question can be put to anyone: there is a VS Code window to show it in. */
  get canAsk(): boolean {
    return this.deps.ask !== undefined;
  }

  /**
   * Put the step's question, and resolve with how it was answered. Never
   * rejects, and never waits past the request's timeout.
   * @param request - The step and its run
   * @param signal - The run's: aborted, the question is given up as cancelled
   */
  ask(request: ApprovalRequest, signal?: AbortSignal): Promise<PipelineApprovalRecord> {
    const now = this.deps.now ?? (() => new Date());
    const key = keyOf(request.operationId, request.stepId);
    const question: ApprovalQuestion = {
      ...request,
      expiresAt: new Date(now().getTime() + request.timeoutMs).toISOString(),
    };

    return new Promise<PipelineApprovalRecord>((resolve) => {
      const settle = (record: PipelineApprovalRecord): void => {
        if (this.waiting.get(key)?.settle !== settle) return;
        this.waiting.delete(key);
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(record);
      };
      const onAbort = (): void => settle({ decision: 'cancelled', at: now().toISOString() });
      const timer = setTimeout(
        () => settle({ decision: 'timedOut', at: now().toISOString() }),
        request.timeoutMs,
      );

      this.waiting.set(key, { question, settle });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });

      this.deps.announce?.(question);
      void this.deps.ask?.(question).then(
        (choice) => {
          if (choice === undefined) return;
          const decision = choice === 'approve' ? 'approved' : 'rejected';
          if (!this.answer(request.operationId, request.stepId, decision, 'notification')) {
            this.deps.tooLate?.(question);
          }
        },
        () => undefined,
      );
    });
  }

  /**
   * Answer a waiting step.
   * @returns Whether a question was waiting: false for one already answered,
   *   given up, or never asked
   */
  answer(
    operationId: string,
    stepId: string,
    decision: 'approved' | 'rejected',
    via: PipelineApprovalChannel,
  ): boolean {
    const waiting = this.waiting.get(keyOf(operationId, stepId));
    if (!waiting) return false;
    const now = this.deps.now ?? (() => new Date());
    const by = this.deps.who?.();
    waiting.settle({ decision, via, at: now().toISOString(), ...(by ? { by } : {}) });
    return true;
  }

  /** Whether a step of a run waits for its answer. */
  isWaiting(operationId: string, stepId: string): boolean {
    return this.waiting.has(keyOf(operationId, stepId));
  }
}
