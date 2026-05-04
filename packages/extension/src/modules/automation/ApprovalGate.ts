/** Possible states of an approval request */
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'timed_out';

/** Configuration options for creating an approval request */
export interface ApprovalConfig {
  approvers: string[];
  requiredApprovals: number;
  timeoutMs: number;
  message?: string;
}

/** Represents a single approval request within a pipeline */
export interface ApprovalRequest {
  id: string;
  pipelineId: string;
  stepName: string;
  requestedBy: string;
  requestedAt: string;
  status: ApprovalStatus;
  approvers: string[];
  requiredApprovals: number;
  receivedApprovals: string[];
  timeoutMs: number;
  message?: string;
}

/**
 * Generates a RFC4122 v4 UUID via the platform crypto primitive.
 * Used internally to assign unique identifiers to approval requests.
 */
function generateId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Manages approval gates within pipeline execution.
 * Allows creating approval requests, recording approvals/rejections,
 * checking timeouts, and querying request history.
 */
export class ApprovalGate {
  private readonly requests: Map<string, ApprovalRequest> = new Map();

  /**
   * Create a new approval request for a pipeline step.
   * @param pipelineId - ID of the pipeline requesting approval
   * @param stepName - Name of the step requiring approval
   * @param requestedBy - User who initiated the request
   * @param config - Approval configuration (approvers, threshold, timeout)
   * @returns The newly created approval request
   */
  createRequest(
    pipelineId: string,
    stepName: string,
    requestedBy: string,
    config: ApprovalConfig,
  ): ApprovalRequest {
    const request: ApprovalRequest = {
      id: generateId(),
      pipelineId,
      stepName,
      requestedBy,
      requestedAt: new Date().toISOString(),
      status: 'pending',
      approvers: [...config.approvers],
      requiredApprovals: config.requiredApprovals,
      receivedApprovals: [],
      timeoutMs: config.timeoutMs,
      message: config.message,
    };

    this.requests.set(request.id, request);
    return request;
  }

  /**
   * Record an approval from a designated approver.
   * Validates that the request exists, the approver is authorized,
   * has not already approved, and the request has not timed out.
   * Automatically transitions status to 'approved' when the threshold is met.
   * @param requestId - ID of the approval request
   * @param approver - The user approving the request
   * @returns The updated approval request, or undefined if validation fails
   */
  approve(requestId: string, approver: string): ApprovalRequest | undefined {
    const request = this.requests.get(requestId);
    if (!request) {
      return undefined;
    }

    if (request.status !== 'pending') {
      return undefined;
    }

    if (!request.approvers.includes(approver)) {
      return undefined;
    }

    if (request.receivedApprovals.includes(approver)) {
      return undefined;
    }

    if (this.isTimedOut(request)) {
      request.status = 'timed_out';
      return undefined;
    }

    request.receivedApprovals.push(approver);

    if (request.receivedApprovals.length >= request.requiredApprovals) {
      request.status = 'approved';
    }

    return { ...request };
  }

  /**
   * Record a rejection from a designated approver.
   * Validates that the request exists, the approver is authorized,
   * and the request is still pending.
   * @param requestId - ID of the approval request
   * @param approver - The user rejecting the request
   * @returns The updated approval request, or undefined if validation fails
   */
  reject(requestId: string, approver: string): ApprovalRequest | undefined {
    const request = this.requests.get(requestId);
    if (!request) {
      return undefined;
    }

    if (request.status !== 'pending') {
      return undefined;
    }

    if (!request.approvers.includes(approver)) {
      return undefined;
    }

    request.status = 'rejected';
    return { ...request };
  }

  /**
   * Check whether an approval request has timed out.
   * If the request is still pending and has exceeded its timeout,
   * the status is automatically set to 'timed_out'.
   * @param requestId - ID of the approval request to check
   * @returns true if the request has timed out, false otherwise
   */
  checkTimeout(requestId: string): boolean {
    const request = this.requests.get(requestId);
    if (!request) {
      return false;
    }

    if (request.status !== 'pending') {
      return request.status === 'timed_out';
    }

    if (this.isTimedOut(request)) {
      request.status = 'timed_out';
      return true;
    }

    return false;
  }

  /**
   * Retrieve a specific approval request by its ID.
   * @param requestId - ID of the request to retrieve
   * @returns The approval request, or undefined if not found
   */
  getRequest(requestId: string): ApprovalRequest | undefined {
    const request = this.requests.get(requestId);
    if (!request) {
      return undefined;
    }
    return { ...request };
  }

  /**
   * Retrieve all approval requests with 'pending' status.
   * @returns Array of pending approval requests
   */
  getPendingRequests(): ApprovalRequest[] {
    return [...this.requests.values()].filter((r) => r.status === 'pending').map((r) => ({ ...r }));
  }

  /**
   * Retrieve the complete history of all approval requests.
   * @returns Array of all approval requests
   */
  getHistory(): ApprovalRequest[] {
    return [...this.requests.values()].map((r) => ({ ...r }));
  }

  /**
   * Determine whether the given request has exceeded its timeout window.
   * @param request - The approval request to evaluate
   * @returns true if the elapsed time exceeds timeoutMs
   */
  private isTimedOut(request: ApprovalRequest): boolean {
    const elapsed = Date.now() - new Date(request.requestedAt).getTime();
    return elapsed >= request.timeoutMs;
  }
}
