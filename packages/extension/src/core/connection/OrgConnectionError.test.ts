import { describe, expect, it, vi } from 'vitest';
import { OrgConnectionError } from './OrgConnectionError';
import { sendHandlerError } from '../../bridge/handlers/HandlerTypes';

describe('OrgConnectionError', () => {
  it('starts its message with its code, as a Salesforce refusal does', () => {
    const err = new OrgConnectionError('ORG_AUTH_EXPIRED', 'org-1', 'The session has expired.');

    expect(err.message).toBe('ORG_AUTH_EXPIRED: The session has expired.');
    expect(err.code).toBe('ORG_AUTH_EXPIRED');
    expect(err.orgId).toBe('org-1');
    expect(err).toBeInstanceOf(Error);
  });

  it("gives a module's error its code and org, where the handler named neither", () => {
    const postToWebview = vi.fn();
    const deps = { log: vi.fn(), broker: { postToWebview }, nextId: () => 'id-1' };

    sendHandlerError(
      deps as never,
      'seed:execute',
      'seed:error',
      { id: 'req-1' } as never,
      new OrgConnectionError('ORG_AUTH_EXPIRED', 'org-7', 'The session has expired.'),
    );

    expect(postToWebview.mock.calls[0][0]).toMatchObject({
      type: 'seed:error',
      correlationId: 'req-1',
      payload: { code: 'ORG_AUTH_EXPIRED', orgId: 'org-7' },
    });
  });

  it('leaves a code the handler names as it is', () => {
    const postToWebview = vi.fn();
    const deps = { log: vi.fn(), broker: { postToWebview }, nextId: () => 'id-1' };

    sendHandlerError(
      deps as never,
      'seed:execute',
      'seed:error',
      { id: 'req-1' } as never,
      new OrgConnectionError('ORG_TEMPORARILY_UNREACHABLE', 'org-7', 'Try again in a minute.'),
      { code: 'SEED_FAILED' },
    );

    expect(postToWebview.mock.calls[0][0].payload.code).toBe('SEED_FAILED');
  });
});
