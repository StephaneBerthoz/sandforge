import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ApprovalGate } from './ApprovalGate';

describe('ApprovalGate', () => {
  let gate: ApprovalGate;

  beforeEach(() => {
    gate = new ApprovalGate();
  });

  describe('createRequest', () => {
    it('should create a pending approval request', () => {
      const request = gate.createRequest('pipeline-1', 'Deploy', 'alice', {
        approvers: ['bob', 'carol'],
        requiredApprovals: 1,
        timeoutMs: 60000,
      });

      expect(request.id).toBeDefined();
      expect(request.pipelineId).toBe('pipeline-1');
      expect(request.stepName).toBe('Deploy');
      expect(request.requestedBy).toBe('alice');
      expect(request.status).toBe('pending');
      expect(request.approvers).toEqual(['bob', 'carol']);
      expect(request.requiredApprovals).toBe(1);
      expect(request.receivedApprovals).toEqual([]);
    });

    it('should assign unique IDs to different requests', () => {
      const req1 = gate.createRequest('p1', 'Step A', 'alice', {
        approvers: ['bob'],
        requiredApprovals: 1,
        timeoutMs: 60000,
      });
      const req2 = gate.createRequest('p1', 'Step B', 'alice', {
        approvers: ['bob'],
        requiredApprovals: 1,
        timeoutMs: 60000,
      });

      expect(req1.id).not.toBe(req2.id);
    });

    it('should store the optional message', () => {
      const request = gate.createRequest('p1', 'Step', 'alice', {
        approvers: ['bob'],
        requiredApprovals: 1,
        timeoutMs: 60000,
        message: 'Please review the deployment',
      });

      expect(request.message).toBe('Please review the deployment');
    });

    it('should set requestedAt to a valid ISO timestamp', () => {
      const request = gate.createRequest('p1', 'Step', 'alice', {
        approvers: ['bob'],
        requiredApprovals: 1,
        timeoutMs: 60000,
      });

      expect(() => new Date(request.requestedAt)).not.toThrow();
      expect(new Date(request.requestedAt).toISOString()).toBe(request.requestedAt);
    });
  });

  describe('approve', () => {
    it('should record an approval from a valid approver', () => {
      const request = gate.createRequest('p1', 'Deploy', 'alice', {
        approvers: ['bob', 'carol'],
        requiredApprovals: 2,
        timeoutMs: 60000,
      });

      const result = gate.approve(request.id, 'bob');

      expect(result).toBeDefined();
      expect(result!.receivedApprovals).toContain('bob');
      expect(result!.status).toBe('pending');
    });

    it('should set status to approved when threshold is met', () => {
      const request = gate.createRequest('p1', 'Deploy', 'alice', {
        approvers: ['bob', 'carol'],
        requiredApprovals: 2,
        timeoutMs: 60000,
      });

      gate.approve(request.id, 'bob');
      const result = gate.approve(request.id, 'carol');

      expect(result).toBeDefined();
      expect(result!.status).toBe('approved');
      expect(result!.receivedApprovals).toEqual(['bob', 'carol']);
    });

    it('should set status to approved with single required approval', () => {
      const request = gate.createRequest('p1', 'Deploy', 'alice', {
        approvers: ['bob'],
        requiredApprovals: 1,
        timeoutMs: 60000,
      });

      const result = gate.approve(request.id, 'bob');

      expect(result).toBeDefined();
      expect(result!.status).toBe('approved');
    });

    it('should return undefined for unknown request ID', () => {
      expect(gate.approve('non-existent', 'bob')).toBeUndefined();
    });

    it('should return undefined for unauthorized approver', () => {
      const request = gate.createRequest('p1', 'Deploy', 'alice', {
        approvers: ['bob'],
        requiredApprovals: 1,
        timeoutMs: 60000,
      });

      expect(gate.approve(request.id, 'eve')).toBeUndefined();
    });

    it('should return undefined if approver already approved', () => {
      const request = gate.createRequest('p1', 'Deploy', 'alice', {
        approvers: ['bob', 'carol'],
        requiredApprovals: 2,
        timeoutMs: 60000,
      });

      gate.approve(request.id, 'bob');
      expect(gate.approve(request.id, 'bob')).toBeUndefined();
    });

    it('should return undefined for already approved requests', () => {
      const request = gate.createRequest('p1', 'Deploy', 'alice', {
        approvers: ['bob'],
        requiredApprovals: 1,
        timeoutMs: 60000,
      });

      gate.approve(request.id, 'bob');
      expect(gate.approve(request.id, 'bob')).toBeUndefined();
    });

    it('should return undefined and set timed_out if request expired', () => {
      vi.useFakeTimers();
      try {
        const request = gate.createRequest('p1', 'Deploy', 'alice', {
          approvers: ['bob'],
          requiredApprovals: 1,
          timeoutMs: 5000,
        });

        vi.advanceTimersByTime(6000);

        expect(gate.approve(request.id, 'bob')).toBeUndefined();

        const updated = gate.getRequest(request.id);
        expect(updated!.status).toBe('timed_out');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('reject', () => {
    it('should reject a pending request', () => {
      const request = gate.createRequest('p1', 'Deploy', 'alice', {
        approvers: ['bob'],
        requiredApprovals: 1,
        timeoutMs: 60000,
      });

      const result = gate.reject(request.id, 'bob');

      expect(result).toBeDefined();
      expect(result!.status).toBe('rejected');
    });

    it('should return undefined for unknown request ID', () => {
      expect(gate.reject('non-existent', 'bob')).toBeUndefined();
    });

    it('should return undefined for unauthorized approver', () => {
      const request = gate.createRequest('p1', 'Deploy', 'alice', {
        approvers: ['bob'],
        requiredApprovals: 1,
        timeoutMs: 60000,
      });

      expect(gate.reject(request.id, 'eve')).toBeUndefined();
    });

    it('should return undefined if already rejected', () => {
      const request = gate.createRequest('p1', 'Deploy', 'alice', {
        approvers: ['bob', 'carol'],
        requiredApprovals: 1,
        timeoutMs: 60000,
      });

      gate.reject(request.id, 'bob');
      expect(gate.reject(request.id, 'carol')).toBeUndefined();
    });
  });

  describe('checkTimeout', () => {
    it('should return false for a non-timed-out request', () => {
      const request = gate.createRequest('p1', 'Deploy', 'alice', {
        approvers: ['bob'],
        requiredApprovals: 1,
        timeoutMs: 60000,
      });

      expect(gate.checkTimeout(request.id)).toBe(false);
    });

    it('should return true and update status when timed out', () => {
      vi.useFakeTimers();
      try {
        const request = gate.createRequest('p1', 'Deploy', 'alice', {
          approvers: ['bob'],
          requiredApprovals: 1,
          timeoutMs: 3000,
        });

        vi.advanceTimersByTime(4000);

        expect(gate.checkTimeout(request.id)).toBe(true);

        const updated = gate.getRequest(request.id);
        expect(updated!.status).toBe('timed_out');
      } finally {
        vi.useRealTimers();
      }
    });

    it('should return false for unknown request ID', () => {
      expect(gate.checkTimeout('non-existent')).toBe(false);
    });

    it('should return true for already timed_out requests', () => {
      vi.useFakeTimers();
      try {
        const request = gate.createRequest('p1', 'Deploy', 'alice', {
          approvers: ['bob'],
          requiredApprovals: 1,
          timeoutMs: 1000,
        });

        vi.advanceTimersByTime(2000);
        gate.checkTimeout(request.id);

        expect(gate.checkTimeout(request.id)).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('getRequest', () => {
    it('should return a copy of the request', () => {
      const original = gate.createRequest('p1', 'Deploy', 'alice', {
        approvers: ['bob'],
        requiredApprovals: 1,
        timeoutMs: 60000,
      });

      const retrieved = gate.getRequest(original.id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe(original.id);
    });

    it('should return undefined for unknown ID', () => {
      expect(gate.getRequest('non-existent')).toBeUndefined();
    });
  });

  describe('getPendingRequests', () => {
    it('should return only pending requests', () => {
      const req1 = gate.createRequest('p1', 'Step A', 'alice', {
        approvers: ['bob'],
        requiredApprovals: 1,
        timeoutMs: 60000,
      });
      gate.createRequest('p1', 'Step B', 'alice', {
        approvers: ['carol'],
        requiredApprovals: 1,
        timeoutMs: 60000,
      });

      gate.approve(req1.id, 'bob');

      const pending = gate.getPendingRequests();
      expect(pending).toHaveLength(1);
      expect(pending[0].stepName).toBe('Step B');
    });

    it('should return empty array when no pending requests exist', () => {
      expect(gate.getPendingRequests()).toEqual([]);
    });
  });

  describe('getHistory', () => {
    it('should return all requests regardless of status', () => {
      const req1 = gate.createRequest('p1', 'Step A', 'alice', {
        approvers: ['bob'],
        requiredApprovals: 1,
        timeoutMs: 60000,
      });
      const req2 = gate.createRequest('p1', 'Step B', 'alice', {
        approvers: ['carol'],
        requiredApprovals: 1,
        timeoutMs: 60000,
      });

      gate.approve(req1.id, 'bob');
      gate.reject(req2.id, 'carol');

      const history = gate.getHistory();
      expect(history).toHaveLength(2);

      const statuses = history.map((r) => r.status);
      expect(statuses).toContain('approved');
      expect(statuses).toContain('rejected');
    });

    it('should return empty array when no requests exist', () => {
      expect(gate.getHistory()).toEqual([]);
    });
  });

  describe('multi-approver workflow', () => {
    it('should track multiple approvals from different approvers', () => {
      const request = gate.createRequest('p1', 'Critical Deploy', 'alice', {
        approvers: ['bob', 'carol', 'dave'],
        requiredApprovals: 2,
        timeoutMs: 60000,
      });

      const after1 = gate.approve(request.id, 'bob');
      expect(after1!.status).toBe('pending');
      expect(after1!.receivedApprovals).toHaveLength(1);

      const after2 = gate.approve(request.id, 'carol');
      expect(after2!.status).toBe('approved');
      expect(after2!.receivedApprovals).toHaveLength(2);
    });
  });
});
