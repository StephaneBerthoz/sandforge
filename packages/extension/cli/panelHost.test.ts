import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPanelHost, orgFromIdentity, problemLine, settles } from './panelHost.js';
import type { PostedMessage } from './panelHost.js';
import type { InfraServices } from '../src/bridge/ExtensionHandlers.js';
import { BackgroundOperationRegistry } from '../src/core/engine/BackgroundOperationRegistry.js';

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

  it('types a Developer Edition org, which says IsSandbox false, as the development org it is', () => {
    const org = orgFromIdentity(session, { ...identity(false), orgType: 'Developer Edition' });
    expect(org.orgType).toBe('Developer');
    expect(org.safetyTier).toBe('low');
    expect(org.metadata.edition).toBe('Developer Edition');
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
    expect(settles(reply('monitor:data', 'req-1'), 'req-1', 'monitor:data')).toBe('answered');
    expect(settles(reply('monitor:data', 'req-2'), 'req-1', 'monitor:data')).toBe(undefined);
    expect(settles(reply('monitor:data'), 'req-1', 'monitor:data')).toBe(undefined);
    expect(settles(reply('monitor:error', 'req-2'), 'req-1', 'monitor:data')).toBe(undefined);
  });

  it('reads the error channel and a bridge refusal as failures of the request', () => {
    expect(settles(reply('monitor:error', 'req-1'), 'req-1', 'monitor:data')).toBe('failed');
    expect(settles(reply('bridge:error', 'req-1'), 'req-1', 'monitor:data')).toBe('refused');
  });

  it("reads as the request's failure an error channel other than its domain's", () => {
    // The clone answers its preview on `seed:clone:error`, which its page
    // listens to; taken for nothing, a refused preview waited out the timeout.
    expect(
      settles(reply('seed:clone:error', 'req-1'), 'req-1', 'seed:clone:preview:response'),
    ).toBe('failed');
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

  it("hands the handlers the seed orchestrator factory a pipeline's Seed step builds its run with", () => {
    // Without it, a Seed step in a headless host failed "this.deps.services
    // .seedOrchestrator is not a function" (live gate E1, 2026-10-30).
    const dir = mkdtempSync(join(tmpdir(), 'sandforge-host-test-'));
    try {
      let seeded: unknown;
      createPanelHost({
        storeDir: dir,
        log: () => undefined,
        waitMs: 5_000,
        compose: ({ services }) => {
          seeded = services.seedOrchestrator;
        },
      });
      expect(typeof seeded).toBe('function');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ends the wait on the error a handler answers on its own channel', async () => {
    // A clone preview of an org nobody registered: the handler says so on
    // `seed:clone:error` at once, and the host reported "unanswered" once it
    // had waited as long as it would.
    const dir = mkdtempSync(join(tmpdir(), 'sandforge-host-test-'));
    try {
      const host = createPanelHost({ storeDir: dir, log: () => undefined, waitMs: 2_000 });

      const preview = await host.request({
        type: 'seed:clone:preview',
        payload: {
          sourceOrgId: '00D000000000009AAA',
          targetOrgId: '00D000000000008AAA',
          objects: [{ objectApiName: 'Account' }],
        },
        timeoutMs: 1_000,
      });

      expect(preview.outcome).toBe('failed');
      expect(preview.message?.type).toBe('seed:clone:error');
      expect(preview.late).toBe(false);
      expect(String((preview.message?.payload as { message?: string }).message)).toContain(
        'Org not found',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs a pipeline as the Automation page does, and writes its notification to the log', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sandforge-host-test-'));
    const lines: string[] = [];
    try {
      const host = createPanelHost({
        storeDir: dir,
        log: (line) => lines.push(line),
        waitMs: 5_000,
      });

      const run = await host.request({
        type: 'pipeline:execute',
        responseType: 'pipeline:run:response',
        payload: {
          pipeline: {
            id: 'p-host',
            name: 'Headless',
            steps: [
              { id: 's1', name: 'Wait', type: 'delay', config: { seconds: 0 } },
              { id: 's2', name: 'Tell', type: 'notification', config: { message: 'Done.' } },
            ],
          },
        },
      });

      expect(run.outcome).toBe('answered');
      expect((run.message?.payload as { status?: string }).status).toBe('completed');
      expect(lines).toContain('  notification: Headless: Done.');
      // Each step reached the page as it went.
      expect(host.posted.filter((m) => m.type === 'pipeline:step')).toHaveLength(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('hands the Monitor a pipeline that carried on past a failed step as partial', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sandforge-host-test-'));
    try {
      const host = createPanelHost({ storeDir: dir, log: () => undefined, waitMs: 5_000 });

      const run = await host.request({
        type: 'pipeline:execute',
        responseType: 'pipeline:run:response',
        payload: {
          pipeline: {
            id: 'p-partial',
            name: 'Part done',
            steps: [
              {
                id: 's1',
                name: 'Too short',
                type: 'delay',
                config: { seconds: 5 },
                timeout: 10,
                continueOnError: true,
              },
              { id: 's2', name: 'Wait', type: 'delay', config: { seconds: 0 } },
            ],
          },
        },
      });
      const listed = await host.request({ type: 'monitor:live-operations' });

      expect((run.message?.payload as { status?: string }).status).toBe('completed_with_warnings');
      expect((listed.message?.payload as { operations?: unknown }).operations).toEqual([
        expect.objectContaining({ module: 'automation', status: 'partial' }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('answers a pipeline stopped from the page with the step stopped, not failed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sandforge-host-test-'));
    try {
      const registry = new BackgroundOperationRegistry();
      let stopping: Promise<unknown> | undefined;
      const host: ReturnType<typeof createPanelHost> = createPanelHost({
        storeDir: dir,
        log: () => undefined,
        waitMs: 5_000,
        compose: ({ handlers }) => {
          handlers.setBackgroundRegistry(registry);
          handlers.setInfraServices({
            backgroundRegistry: registry,
          } as Partial<InfraServices> as InfraServices);
        },
        // The run's first step started: Cancel, as the page sends it.
        onPost: (message) => {
          if (message.type !== 'pipeline:step' || stopping) return;
          const { operationId } = message.payload as { operationId: string };
          stopping = Promise.resolve().then(() =>
            host.request({ type: 'execution:abort', payload: { operationId } }),
          );
        },
      });

      const run = await host.request({
        type: 'pipeline:execute',
        responseType: 'pipeline:run:response',
        payload: {
          pipeline: {
            id: 'p-stopped',
            name: 'Stopped',
            steps: [
              { id: 's1', name: 'Long', type: 'delay', config: { seconds: 60 } },
              { id: 's2', name: 'Next', type: 'delay', config: { seconds: 0 } },
            ],
          },
        },
      });
      await stopping;
      const listed = await host.request({ type: 'monitor:live-operations' });

      expect(run.message?.payload).toMatchObject({
        status: 'cancelled',
        stepResults: [{ stepId: 's1', status: 'stopped' }],
      });
      expect(host.posted.filter((m) => m.type === 'pipeline:step').at(-1)?.payload).toMatchObject({
        stepId: 's1',
        status: 'stopped',
      });
      expect((listed.message?.payload as { operations?: unknown }).operations).toEqual([
        expect.objectContaining({ module: 'automation', status: 'cancelled' }),
      ]);
      registry.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tells whoever runs it of each message as it is posted, before the answer comes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sandforge-host-test-'));
    try {
      const told: string[] = [];
      let answered = false;
      const host = createPanelHost({
        storeDir: dir,
        log: () => undefined,
        waitMs: 5_000,
        onPost: (message) => told.push(`${message.type}${answered ? ' after' : ''}`),
      });

      const run = await host.request({
        type: 'pipeline:execute',
        responseType: 'pipeline:run:response',
        payload: {
          pipeline: {
            id: 'p-told',
            name: 'Told',
            steps: [{ id: 's1', name: 'Wait', type: 'delay', config: { seconds: 0 } }],
          },
        },
      });
      answered = true;

      expect(run.outcome).toBe('answered');
      expect(told).toEqual(host.posted.map((message) => message.type));
      expect(told).toContain('pipeline:step');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
