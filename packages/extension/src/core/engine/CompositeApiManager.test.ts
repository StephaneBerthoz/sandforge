import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CompositeApiManager } from './CompositeApiManager';
import type {
  CompositeRequest,
  CompositeResult,
  CompositeGraphResult,
} from './CompositeApiManager';

function createRequest(refId: string, method: 'POST' | 'PATCH' = 'POST'): CompositeRequest {
  return {
    referenceId: refId,
    method,
    url: `/services/data/v59.0/sobjects/Account`,
    body: { Name: `Test ${refId}` },
  };
}

function createResult(refId: string, status: number = 200): CompositeResult {
  return {
    referenceId: refId,
    httpStatusCode: status,
    body: { id: `001xx${refId}`, success: status >= 200 && status < 300 },
  };
}

describe('CompositeApiManager', () => {
  let manager: CompositeApiManager;

  beforeEach(() => {
    manager = new CompositeApiManager();
  });

  describe('selectStrategy', () => {
    it('should select composite for 25 or fewer requests', () => {
      expect(manager.selectStrategy(1)).toBe('composite');
      expect(manager.selectStrategy(25)).toBe('composite');
    });

    it('should select compositeGraph for more than 25 requests', () => {
      expect(manager.selectStrategy(26)).toBe('compositeGraph');
      expect(manager.selectStrategy(100)).toBe('compositeGraph');
      expect(manager.selectStrategy(500)).toBe('compositeGraph');
    });
  });

  describe('limits', () => {
    it('should return composite limit of 25', () => {
      expect(manager.getCompositeLimit()).toBe(25);
    });

    it('should return graph limit of 500', () => {
      expect(manager.getGraphLimit()).toBe(500);
    });
  });

  describe('execute', () => {
    it('should return empty array for empty requests', async () => {
      const executor = vi.fn();
      const results = await manager.execute([], executor);

      expect(results).toEqual([]);
      expect(executor).not.toHaveBeenCalled();
    });

    it('should call executor once for composite strategy', async () => {
      const requests = [createRequest('ref1'), createRequest('ref2')];
      const expectedResults = [createResult('ref1'), createResult('ref2')];
      const executor = vi.fn().mockResolvedValue(expectedResults);

      const results = await manager.execute(requests, executor);

      expect(executor).toHaveBeenCalledTimes(1);
      expect(executor).toHaveBeenCalledWith(requests);
      expect(results).toEqual(expectedResults);
    });

    it('should split into batches for graph strategy', async () => {
      const requests: CompositeRequest[] = [];
      for (let i = 0; i < 30; i++) {
        requests.push(createRequest(`ref${i}`));
      }

      const executor = vi
        .fn()
        .mockImplementation((batch: CompositeRequest[]) =>
          Promise.resolve(batch.map((r) => createResult(r.referenceId))),
        );

      const results = await manager.execute(requests, executor);

      expect(executor).toHaveBeenCalledTimes(2);
      expect(results).toHaveLength(30);
    });
  });

  describe('buildCompositeBody', () => {
    it('should build a composite request body', () => {
      const requests = [createRequest('ref1'), createRequest('ref2')];
      const body = manager.buildCompositeBody(requests);

      expect(body.allOrNone).toBe(false);
      expect(body.compositeRequest).toHaveLength(2);
    });

    it('should cap at composite limit', () => {
      const requests: CompositeRequest[] = [];
      for (let i = 0; i < 30; i++) {
        requests.push(createRequest(`ref${i}`));
      }

      const body = manager.buildCompositeBody(requests);
      expect(body.compositeRequest).toHaveLength(25);
    });
  });

  describe('buildGraphBody', () => {
    it('should build a single graph for small requests', () => {
      const requests = [createRequest('ref1'), createRequest('ref2')];
      const body = manager.buildGraphBody(requests);

      expect(body.graphs).toHaveLength(1);
      expect(body.graphs[0].graphId).toBe('graph-0');
      expect(body.graphs[0].compositeRequest).toHaveLength(2);
    });

    it('should build multiple graphs for large requests', () => {
      const requests: CompositeRequest[] = [];
      for (let i = 0; i < 60; i++) {
        requests.push(createRequest(`ref${i}`));
      }

      const body = manager.buildGraphBody(requests);
      expect(body.graphs).toHaveLength(3);
      expect(body.graphs[0].compositeRequest).toHaveLength(25);
      expect(body.graphs[1].compositeRequest).toHaveLength(25);
      expect(body.graphs[2].compositeRequest).toHaveLength(10);
    });
  });

  describe('parseCompositeResponse', () => {
    it('should map results by referenceId', () => {
      const results = [createResult('ref1'), createResult('ref2')];
      const map = manager.parseCompositeResponse(results);

      expect(map.size).toBe(2);
      expect(map.get('ref1')?.httpStatusCode).toBe(200);
      expect(map.get('ref2')?.httpStatusCode).toBe(200);
    });

    it('should handle empty response', () => {
      const map = manager.parseCompositeResponse([]);
      expect(map.size).toBe(0);
    });
  });

  describe('parseGraphResponse', () => {
    it('should flatten graph results', () => {
      const graphResults: CompositeGraphResult[] = [
        {
          graphId: 'graph-0',
          graphResponse: {
            compositeResponse: [createResult('ref1'), createResult('ref2')],
          },
        },
        {
          graphId: 'graph-1',
          graphResponse: {
            compositeResponse: [createResult('ref3')],
          },
        },
      ];

      const results = manager.parseGraphResponse(graphResults);
      expect(results).toHaveLength(3);
      expect(results[0].referenceId).toBe('ref1');
      expect(results[2].referenceId).toBe('ref3');
    });

    it('should handle empty graph results', () => {
      const results = manager.parseGraphResponse([]);
      expect(results).toHaveLength(0);
    });
  });

  describe('extractErrors', () => {
    it('should extract non-2xx results', () => {
      const results = [
        createResult('ref1', 200),
        createResult('ref2', 400),
        createResult('ref3', 201),
        createResult('ref4', 500),
      ];

      const errors = manager.extractErrors(results);
      expect(errors).toHaveLength(2);
      expect(errors[0].referenceId).toBe('ref2');
      expect(errors[1].referenceId).toBe('ref4');
    });

    it('should return empty array when all successful', () => {
      const results = [createResult('ref1', 200), createResult('ref2', 201)];
      expect(manager.extractErrors(results)).toHaveLength(0);
    });
  });

  describe('isAllSuccessful', () => {
    it('should return true when all results are 2xx', () => {
      const results = [createResult('ref1', 200), createResult('ref2', 201)];
      expect(manager.isAllSuccessful(results)).toBe(true);
    });

    it('should return false when any result is non-2xx', () => {
      const results = [createResult('ref1', 200), createResult('ref2', 400)];
      expect(manager.isAllSuccessful(results)).toBe(false);
    });

    it('should return true for empty results', () => {
      expect(manager.isAllSuccessful([])).toBe(true);
    });
  });

  describe('generateReferenceId', () => {
    it('should generate a reference ID from object name and index', () => {
      expect(manager.generateReferenceId('Account', 0)).toBe('Account_0');
      expect(manager.generateReferenceId('Contact', 5)).toBe('Contact_5');
    });
  });

  describe('resolveReference', () => {
    it('should build a reference expression', () => {
      expect(manager.resolveReference('Account_0', 'Id')).toBe('@{Account_0.Id}');
    });
  });

  describe('validate', () => {
    it('should accept empty requests', () => {
      expect(manager.validate([])).toEqual({ valid: true });
    });

    it('should accept valid requests within limits', () => {
      const requests = [createRequest('ref1'), createRequest('ref2')];
      expect(manager.validate(requests)).toEqual({ valid: true });
    });

    it('should reject requests exceeding graph limit', () => {
      const requests: CompositeRequest[] = [];
      for (let i = 0; i < 501; i++) {
        requests.push(createRequest(`ref${i}`));
      }

      const result = manager.validate(requests);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('501');
      expect(result.error).toContain('500');
    });

    it('should reject duplicate referenceIds', () => {
      const requests = [createRequest('ref1'), createRequest('ref1')];
      const result = manager.validate(requests);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Duplicate referenceId');
    });
  });
});
