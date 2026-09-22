import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPanelHost, orgFromIdentity, problemLine, settles } from './panelHost.js';
import type { PostedMessage } from './panelHost.js';

const session = {
  alias: 'TGT',
  username: 'admin@example.com',
  instanceUrl: 'https://example.my.salesforce.com',
  accessToken: 'not-a-token',
};

const identity = (isSandbox: boolean) => ({
  userId: '005000000000001AAA',
  username: 'admin@example.com',
  displayName: 'Admin',
  orgId: '00D000000000001AAA',
  orgName: 'Example',
  orgType: 'Enterprise Edition',
  isSandbox,
});

describe('orgFromIdentity', () => {
  it('registers the org under its own id, typed from Organization.IsSandbox', () => {
    const org = orgFromIdentity(session, identity(true));
    expect(org.id).toBe('00D000000000001AAA');
    expect(org.orgType).toBe('Sandbox');
    expect(org.metadata.edition).toBe('Enterprise Edition');
  });

  it('types an org that is not a sandbox as production, whatever its alias says', () => {
    const org = orgFromIdentity({ ...session, alias: 'my-sandbox' }, identity(false));
    expect(org.orgType).toBe('Production');
    expect(org.safetyTier).toBe('critical');
  });
});

describe('settles', () => {
  const reply = (type: string, correlationId?: string): PostedMessage => ({
    id: 'r',
    type,
    timestamp: 0,
    ...(correlationId ? { correlationId } : {}),
  });

  it('takes only the messages that carry the request id, as the page hooks do', () => {
    expect(settles(reply('monitor:data', 'req-1'), 'req-1', 'monitor:data', 'monitor:error')).toBe(
      'answered',
    );
    expect(settles(reply('monitor:data', 'req-2'), 'req-1', 'monitor:data', 'monitor:error')).toBe(
      undefined,
    );
    expect(settles(reply('monitor:data'), 'req-1', 'monitor:data', 'monitor:error')).toBe(
      undefined,
    );
  });

  it('reads the error channel and a bridge refusal as failures of the request', () => {
    expect(settles(reply('monitor:error', 'req-1'), 'req-1', 'monitor:data', 'monitor:error')).toBe(
      'failed',
    );
    expect(settles(reply('bridge:error', 'req-1'), 'req-1', 'monitor:data', 'monitor:error')).toBe(
      'refused',
    );
  });
});

describe('problemLine', () => {
  it('flags an error channel message and says nothing about a plain answer', () => {
    expect(
      problemLine({ id: 'e', type: 'compare:error', timestamp: 0, payload: { message: 'boom' } }),
    ).toBe('! compare:error: boom');
    expect(problemLine({ id: 'a', type: 'compare:drift:response', timestamp: 0 })).toBeUndefined();
  });
});

describe('createPanelHost', () => {
  it("answers a request through the extension's own routing, and refuses what it does not know", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sandforge-host-test-'));
    try {
      const host = createPanelHost({ storeDir: dir, log: () => undefined, waitMs: 5_000 });

      const alerts = await host.request({
        type: 'monitor:alerts',
        responseType: 'monitor:alerts:result',
      });
      expect(alerts.outcome).toBe('answered');
      expect(alerts.message?.payload).toEqual({ alerts: [], history: [] });

      // An org nobody registered: the handler's own refusal, on its channel.
      const storage = await host.request({
        type: 'monitor:storage',
        payload: { orgId: '00D000000000009AAA' },
      });
      expect(storage.outcome).toBe('failed');
      expect(String((storage.message?.payload as { message?: string }).message)).toContain(
        'Org not found',
      );

      // A type the bridge schema does not know never reaches a handler.
      const unknown = await host.request({ type: 'monitor:no-such-request' });
      expect(unknown.outcome).toBe('refused');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
