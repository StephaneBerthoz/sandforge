import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type * as vscode from 'vscode';
import type { BaseMessage } from '@sandforge/shared';
import { PROTOCOL_VERSION } from '@sandforge/shared';
import { MessageBroker } from './MessageBroker';
import type { MessageHandler, BrokerTelemetry } from './MessageBroker';

interface MockWebview {
  onDidReceiveMessage: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
}

interface MockPanel {
  webview: MockWebview;
}

function createMockPanel(): MockPanel {
  return {
    webview: {
      onDidReceiveMessage: vi.fn().mockReturnValue({ dispose: vi.fn() }),
      postMessage: vi.fn(),
    },
  };
}

function createMessage(type: string, overrides: Partial<BaseMessage> = {}): BaseMessage {
  return {
    id: `msg-${Date.now()}`,
    type,
    timestamp: Date.now(),
    ...overrides,
  };
}

/**
 * Wraps a raw message in the protocol envelope — the only shape the webview
 * ever sends (pre-envelope clients cannot exist within the same VSIX).
 * Typed as BaseMessage so existing `messageCallback` casts stay unchanged.
 */
function enveloped(payload: BaseMessage): BaseMessage {
  return { protocolVersion: PROTOCOL_VERSION, payload } as unknown as BaseMessage;
}

describe('MessageBroker', () => {
  let broker: MessageBroker;

  beforeEach(() => {
    broker = new MessageBroker();
  });

  describe('registerPanel', () => {
    it('should add the panel and subscribe to its messages', () => {
      const panel = createMockPanel();

      broker.registerPanel(panel as unknown as vscode.WebviewPanel);

      expect(broker.panelCount).toBe(1);
      expect(panel.webview.onDidReceiveMessage).toHaveBeenCalledOnce();
    });

    it('should dispatch incoming panel messages to registered handlers', () => {
      const panel = createMockPanel();
      const handler = vi.fn<MessageHandler>();
      broker.on('org:list', handler);

      broker.registerPanel(panel as unknown as vscode.WebviewPanel);

      const messageCallback = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (
        msg: BaseMessage,
      ) => void;
      const message = createMessage('org:list');
      messageCallback(enveloped(message));

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(message);
    });

    it('should return a disposable that removes the panel', () => {
      const panel = createMockPanel();
      const innerDispose = vi.fn();
      panel.webview.onDidReceiveMessage.mockReturnValue({ dispose: innerDispose });

      const disposable = broker.registerPanel(panel as unknown as vscode.WebviewPanel);

      expect(broker.panelCount).toBe(1);

      disposable.dispose();

      expect(broker.panelCount).toBe(0);
      expect(innerDispose).toHaveBeenCalledOnce();
    });

    it('should support registering multiple panels', () => {
      const panel1 = createMockPanel();
      const panel2 = createMockPanel();

      broker.registerPanel(panel1 as unknown as vscode.WebviewPanel);
      broker.registerPanel(panel2 as unknown as vscode.WebviewPanel);

      expect(broker.panelCount).toBe(2);
    });

    it('should NOT subscribe to inbound messages with { inbound: false } but still broadcast', () => {
      const view = createMockPanel();

      broker.registerPanel(view as unknown as vscode.WebviewView, { inbound: false });

      // No inbound subscription: outbound-only views (sidebar) send raw
      // messages without id/timestamp that would fail validation + the rate
      // limiter.
      expect(view.webview.onDidReceiveMessage).not.toHaveBeenCalled();
      expect(broker.panelCount).toBe(1);

      // Broadcasts still reach the view.
      const message = createMessage('operation:started');
      broker.postToWebview(message);
      expect(view.webview.postMessage).toHaveBeenCalledWith(message);
    });

    it('should unregister an inbound:false view via the returned disposable', () => {
      const view = createMockPanel();

      const disposable = broker.registerPanel(view as unknown as vscode.WebviewView, {
        inbound: false,
      });

      expect(broker.panelCount).toBe(1);
      disposable.dispose();
      expect(broker.panelCount).toBe(0);

      broker.postToWebview(createMessage('operation:started'));
      expect(view.webview.postMessage).not.toHaveBeenCalled();
    });
  });

  describe('replyToRequester', () => {
    /** A panel, and a way to send the broker a request from it. */
    function asker() {
      const panel = createMockPanel();
      const registration = broker.registerPanel(panel as unknown as vscode.WebviewPanel);
      const inbound = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (msg: unknown) => void;
      return {
        panel,
        registration,
        ask: (id: string) => inbound(enveloped(createMessage('i18n:locale', { id }))),
      };
    }
    const answerTo = (id: string) => createMessage('i18n:locale:response', { correlationId: id });

    beforeEach(() => {
      broker.on('i18n:locale', vi.fn());
    });

    it('answers the webview that asked, and no other', () => {
      const a = asker();
      const b = asker();
      const sidebar = createMockPanel();
      broker.registerPanel(sidebar as unknown as vscode.WebviewView, { inbound: false });
      a.ask('req-a');

      const answer = answerTo('req-a');
      broker.replyToRequester(answer);

      expect(a.panel.webview.postMessage).toHaveBeenCalledWith(answer);
      expect(b.panel.webview.postMessage).not.toHaveBeenCalled();
      expect(sidebar.webview.postMessage).not.toHaveBeenCalled();
    });

    it('sends to every webview when the one that asked is not known, or has closed', () => {
      const a = asker();
      const b = asker();
      broker.replyToRequester(answerTo('never-asked'));
      expect(a.panel.webview.postMessage).toHaveBeenCalledTimes(1);
      expect(b.panel.webview.postMessage).toHaveBeenCalledTimes(1);

      b.ask('req-b');
      b.registration.dispose();
      broker.replyToRequester(answerTo('req-b'));
      expect(a.panel.webview.postMessage).toHaveBeenCalledTimes(2);
    });

    it('remembers a bounded number of askers, the oldest forgotten first', () => {
      // A thousand requests at once: past the rate limit a request is
      // dropped, with a bridge error to every webview.
      broker = new MessageBroker({ rateLimitMax: 10_000 });
      broker.on('i18n:locale', vi.fn());
      const a = asker();
      const b = asker();
      a.ask('first');
      for (let n = 0; n < 1_000; n++) b.ask(`later-${n}`);

      broker.replyToRequester(answerTo('later-999'));
      expect(a.panel.webview.postMessage).not.toHaveBeenCalled();

      broker.replyToRequester(answerTo('first'));
      // Forgotten, so sent to every webview rather than lost.
      expect(a.panel.webview.postMessage).toHaveBeenCalledTimes(1);
      expect(b.panel.webview.postMessage).toHaveBeenCalledTimes(2);
    });
  });

  describe('onFirstWebview', () => {
    it('waits for the first webview, then runs once whatever registers after', () => {
      const callback = vi.fn();
      broker.onFirstWebview(callback);
      expect(callback).not.toHaveBeenCalled();

      const sidebar = broker.registerPanel(createMockPanel() as unknown as vscode.WebviewView, {
        inbound: false,
      });
      expect(callback).toHaveBeenCalledTimes(1);

      sidebar.dispose();
      broker.registerPanel(createMockPanel() as unknown as vscode.WebviewPanel);
      broker.registerPanel(createMockPanel() as unknown as vscode.WebviewPanel);
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('runs at once when a webview has already registered', () => {
      broker.registerPanel(createMockPanel() as unknown as vscode.WebviewPanel);
      const callback = vi.fn();

      broker.onFirstWebview(callback);

      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('runs every waiting callback when one of them throws, and still registers the webview', () => {
      const log = vi.fn();
      broker.setLogFunction(log);
      const after = vi.fn();
      broker.onFirstWebview(() => {
        throw new Error('composition failed');
      });
      broker.onFirstWebview(after);

      broker.registerPanel(createMockPanel() as unknown as vscode.WebviewPanel);

      expect(after).toHaveBeenCalledTimes(1);
      expect(broker.panelCount).toBe(1);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('composition failed'));
    });
  });

  describe('on', () => {
    it('should register a handler for the given type', () => {
      const handler = vi.fn<MessageHandler>();
      broker.on('seed:execute', handler);

      const panel = createMockPanel();
      broker.registerPanel(panel as unknown as vscode.WebviewPanel);

      const messageCallback = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (
        msg: BaseMessage,
      ) => void;
      messageCallback(enveloped(createMessage('seed:execute')));

      expect(handler).toHaveBeenCalledOnce();
    });

    it('should not call handler for a different message type', () => {
      const handler = vi.fn<MessageHandler>();
      broker.on('seed:execute', handler);

      const panel = createMockPanel();
      broker.registerPanel(panel as unknown as vscode.WebviewPanel);

      const messageCallback = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (
        msg: BaseMessage,
      ) => void;
      messageCallback(enveloped(createMessage('sync:execute')));

      expect(handler).not.toHaveBeenCalled();
    });

    it('should support multiple handlers for the same type', () => {
      const handler1 = vi.fn<MessageHandler>();
      const handler2 = vi.fn<MessageHandler>();
      broker.on('org:list', handler1);
      broker.on('org:list', handler2);

      const panel = createMockPanel();
      broker.registerPanel(panel as unknown as vscode.WebviewPanel);

      const messageCallback = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (
        msg: BaseMessage,
      ) => void;
      messageCallback(enveloped(createMessage('org:list')));

      expect(handler1).toHaveBeenCalledOnce();
      expect(handler2).toHaveBeenCalledOnce();
    });

    it('should return an unsubscribe function that removes the handler', () => {
      const handler = vi.fn<MessageHandler>();
      const unsubscribe = broker.on('org:list', handler);

      unsubscribe();

      const panel = createMockPanel();
      broker.registerPanel(panel as unknown as vscode.WebviewPanel);

      const messageCallback = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (
        msg: BaseMessage,
      ) => void;
      messageCallback(enveloped(createMessage('org:list')));

      expect(handler).not.toHaveBeenCalled();
    });

    it('should catch errors from async handlers without crashing', async () => {
      const handler = vi.fn().mockRejectedValue(new Error('async boom'));
      broker.on('org:connect', handler);

      const panel = createMockPanel();
      broker.registerPanel(panel as unknown as vscode.WebviewPanel);

      const messageCallback = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (
        msg: BaseMessage,
      ) => void;
      messageCallback(enveloped(createMessage('org:connect')));

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(handler).toHaveBeenCalledOnce();
      // Errors are silently caught to prevent broker crash
    });

    it('should catch errors from sync handlers without crashing', () => {
      const handler = vi.fn().mockImplementation(() => {
        throw new Error('sync boom');
      });
      broker.on('org:list', handler);

      const panel = createMockPanel();
      broker.registerPanel(panel as unknown as vscode.WebviewPanel);

      const messageCallback = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (
        msg: BaseMessage,
      ) => void;
      messageCallback(enveloped(createMessage('org:list')));

      expect(handler).toHaveBeenCalledOnce();
      // Errors are silently caught to prevent broker crash
    });

    it('should log errors from sync handlers via logFn', () => {
      const logFn = vi.fn();
      broker.setLogFunction(logFn);

      const handler = vi.fn().mockImplementation(() => {
        throw new Error('sync boom');
      });
      broker.on('org:list', handler);

      const panel = createMockPanel();
      broker.registerPanel(panel as unknown as vscode.WebviewPanel);

      const messageCallback = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (
        msg: BaseMessage,
      ) => void;
      messageCallback(enveloped(createMessage('org:list')));

      expect(logFn).toHaveBeenCalledOnce();
      expect(logFn).toHaveBeenCalledWith(
        expect.stringContaining('[MessageBroker] Handler error for "org:list": sync boom'),
      );
    });

    it('should log errors from async handlers via logFn', async () => {
      const logFn = vi.fn();
      broker.setLogFunction(logFn);

      const handler = vi.fn().mockRejectedValue(new Error('async boom'));
      broker.on('org:connect', handler);

      const panel = createMockPanel();
      broker.registerPanel(panel as unknown as vscode.WebviewPanel);

      const messageCallback = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (
        msg: BaseMessage,
      ) => void;
      messageCallback(enveloped(createMessage('org:connect')));

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(logFn).toHaveBeenCalledOnce();
      expect(logFn).toHaveBeenCalledWith(
        expect.stringContaining('[MessageBroker] Handler error for "org:connect": async boom'),
      );
    });
  });

  describe('postToWebview', () => {
    it('should send the message to all registered panels', () => {
      const panel1 = createMockPanel();
      const panel2 = createMockPanel();
      broker.registerPanel(panel1 as unknown as vscode.WebviewPanel);
      broker.registerPanel(panel2 as unknown as vscode.WebviewPanel);

      const message = createMessage('operation:started');
      broker.postToWebview(message);

      expect(panel1.webview.postMessage).toHaveBeenCalledWith(message);
      expect(panel2.webview.postMessage).toHaveBeenCalledWith(message);
    });

    it('should not fail when no panels are registered', () => {
      const message = createMessage('operation:started');
      expect(() => broker.postToWebview(message)).not.toThrow();
    });

    it('should not send to panels that have been unregistered', () => {
      const panel = createMockPanel();
      const disposable = broker.registerPanel(panel as unknown as vscode.WebviewPanel);
      disposable.dispose();

      broker.postToWebview(createMessage('notification'));

      expect(panel.webview.postMessage).not.toHaveBeenCalled();
    });
  });

  describe('Zod validation in dispatch', () => {
    it('should drop messages with missing id and log error', () => {
      const logFn = vi.fn();
      broker.setLogFunction(logFn);

      const handler = vi.fn<MessageHandler>();
      broker.on('org:list', handler);

      const panel = createMockPanel();
      broker.registerPanel(panel as unknown as vscode.WebviewPanel);

      const messageCallback = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (
        msg: unknown,
      ) => void;
      messageCallback({ type: 'org:list', timestamp: Date.now() });

      expect(handler).not.toHaveBeenCalled();
      expect(logFn).toHaveBeenCalledWith(
        expect.stringContaining('[MessageBroker] Received malformed message'),
      );
    });

    it('should drop messages with empty type and log error', () => {
      const logFn = vi.fn();
      broker.setLogFunction(logFn);

      const handler = vi.fn<MessageHandler>();
      broker.on('', handler);

      const panel = createMockPanel();
      broker.registerPanel(panel as unknown as vscode.WebviewPanel);

      const messageCallback = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (
        msg: unknown,
      ) => void;
      messageCallback({ id: 'msg-1', type: '', timestamp: Date.now() });

      expect(handler).not.toHaveBeenCalled();
      expect(logFn).toHaveBeenCalledWith(
        expect.stringContaining('[MessageBroker] Received malformed message'),
      );
    });

    it('should drop messages with missing timestamp and log error', () => {
      const logFn = vi.fn();
      broker.setLogFunction(logFn);

      const handler = vi.fn<MessageHandler>();
      broker.on('org:list', handler);

      const panel = createMockPanel();
      broker.registerPanel(panel as unknown as vscode.WebviewPanel);

      const messageCallback = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (
        msg: unknown,
      ) => void;
      messageCallback({ id: 'msg-1', type: 'org:list' });

      expect(handler).not.toHaveBeenCalled();
      expect(logFn).toHaveBeenCalledWith(
        expect.stringContaining('[MessageBroker] Received malformed message'),
      );
    });

    it('should drop null messages and log error', () => {
      const logFn = vi.fn();
      broker.setLogFunction(logFn);

      const handler = vi.fn<MessageHandler>();
      broker.on('org:list', handler);

      const panel = createMockPanel();
      broker.registerPanel(panel as unknown as vscode.WebviewPanel);

      const messageCallback = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (
        msg: unknown,
      ) => void;
      messageCallback(null);

      expect(handler).not.toHaveBeenCalled();
      expect(logFn).toHaveBeenCalledWith(
        expect.stringContaining('[MessageBroker] Received malformed message'),
      );
    });

    it('should accept valid messages with extra payload fields', () => {
      const handler = vi.fn<MessageHandler>();
      broker.on('seed:execute', handler);

      const panel = createMockPanel();
      broker.registerPanel(panel as unknown as vscode.WebviewPanel);

      const messageCallback = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (
        msg: BaseMessage,
      ) => void;
      messageCallback(
        enveloped({
          id: 'msg-1',
          type: 'seed:execute',
          timestamp: Date.now(),
          payload: { templateId: 't1' },
        } as BaseMessage),
      );

      expect(handler).toHaveBeenCalledOnce();
    });
  });

  describe('dispose', () => {
    it('should clear all handlers and panels', () => {
      const handler = vi.fn<MessageHandler>();
      broker.on('org:list', handler);

      const panel = createMockPanel();
      broker.registerPanel(panel as unknown as vscode.WebviewPanel);

      broker.dispose();

      expect(broker.panelCount).toBe(0);

      broker.postToWebview(createMessage('notification'));
      expect(panel.webview.postMessage).not.toHaveBeenCalled();
    });

    it('should not dispatch messages after dispose', () => {
      const handler = vi.fn<MessageHandler>();
      broker.on('org:list', handler);

      const panel = createMockPanel();
      broker.registerPanel(panel as unknown as vscode.WebviewPanel);

      broker.dispose();

      const messageCallback = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (
        msg: BaseMessage,
      ) => void;
      messageCallback(enveloped(createMessage('org:list')));

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('envelope + protocol version handling', () => {
    function createTelemetry(): BrokerTelemetry & {
      addBreadcrumb: Mock<BrokerTelemetry['addBreadcrumb']>;
      /** The logger's own warn, which takes what is logged and an optional message. */
      warn: Mock<(obj: unknown, msg?: string) => void>;
    } {
      const warn = vi.fn<(obj: unknown, msg?: string) => void>();
      return {
        addBreadcrumb: vi.fn<BrokerTelemetry['addBreadcrumb']>(),
        getLogger: () => ({ warn }),
        warn,
      };
    }

    it('dispatches payload only (envelope stripped) when envelope is valid and version matches', () => {
      const telemetry = createTelemetry();
      broker = new MessageBroker({ telemetry });

      const handler = vi.fn<MessageHandler>();
      broker.on('org:list', handler);

      const panel = createMockPanel();
      broker.registerPanel(panel as unknown as vscode.WebviewPanel);

      const innerMsg = createMessage('org:list');
      const envelope = {
        protocolVersion: PROTOCOL_VERSION,
        correlationId: 'req-1',
        payload: innerMsg,
      };

      const messageCallback = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (
        msg: unknown,
      ) => void;
      messageCallback(envelope);

      expect(handler).toHaveBeenCalledOnce();
      // Handler receives ONLY the inner payload — envelope stripped.
      expect(handler).toHaveBeenCalledWith(innerMsg);
      // No bridge:* error/mismatch posted
      const postedTypes = panel.webview.postMessage.mock.calls.map(
        (args) => (args[0] as BaseMessage).type,
      );
      expect(postedTypes).not.toContain('bridge:error');
      expect(postedTypes).not.toContain('bridge:protocol-mismatch');
      expect(postedTypes).not.toContain('bridge:reload-banner');
    });

    it('posts bridge:error back to webview when envelope payload is malformed', () => {
      const telemetry = createTelemetry();
      broker = new MessageBroker({ telemetry });

      const panel = createMockPanel();
      broker.registerPanel(panel as unknown as vscode.WebviewPanel);

      const messageCallback = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (
        msg: unknown,
      ) => void;
      messageCallback({
        protocolVersion: PROTOCOL_VERSION,
        payload: { id: 'x', type: 'totally:unknown', timestamp: 1 },
      });

      const postedTypes = panel.webview.postMessage.mock.calls.map(
        (args) => (args[0] as BaseMessage).type,
      );
      expect(postedTypes).toContain('bridge:error');
      expect(telemetry.addBreadcrumb).toHaveBeenCalledWith(
        expect.stringContaining('invalid payload'),
        'bridge',
        'warning',
      );
    });

    it('correlates bridge:error to the message that failed validation', () => {
      // Without this the rejection is a bare broadcast: the hook that sent the
      // dropped message waits out its full timeout, and every other in-flight
      // hook has to guess whether the broadcast was meant for it.
      broker = new MessageBroker({});
      const panel = createMockPanel();
      broker.registerPanel(panel as unknown as vscode.WebviewPanel);

      const messageCallback = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (
        msg: unknown,
      ) => void;
      messageCallback({
        protocolVersion: PROTOCOL_VERSION,
        payload: { id: 'req-abc', type: 'totally:unknown', timestamp: 1 },
      });

      const err = panel.webview.postMessage.mock.calls
        .map((args) => args[0] as BaseMessage)
        .find((m) => m.type === 'bridge:error');
      expect(err?.correlationId).toBe('req-abc');
    });

    it('leaves bridge:error uncorrelated when no id can be read', () => {
      // A payload too malformed to yield an id is genuinely un-attributable,
      // and inventing an owner for it is what the correlation replaces.
      broker = new MessageBroker({});
      const panel = createMockPanel();
      broker.registerPanel(panel as unknown as vscode.WebviewPanel);

      const messageCallback = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (
        msg: unknown,
      ) => void;
      messageCallback({ protocolVersion: PROTOCOL_VERSION, payload: { id: 42 } });

      const err = panel.webview.postMessage.mock.calls
        .map((args) => args[0] as BaseMessage)
        .find((m) => m.type === 'bridge:error');
      expect(err).toBeDefined();
      expect(err?.correlationId).toBeUndefined();
    });

    it('truncates oversized validation details in bridge:error to ~500 chars', () => {
      const panel = createMockPanel();
      broker.registerPanel(panel as unknown as vscode.WebviewPanel);

      const messageCallback = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (
        msg: unknown,
      ) => void;
      // Unknown type → the discriminator error enumerates every known literal
      // (~300 values ≈ 6.5 kB) — the posted details must stay bounded.
      messageCallback({
        protocolVersion: PROTOCOL_VERSION,
        payload: { id: 'x', type: 'totally:unknown', timestamp: 1 },
      });

      const errorPost = panel.webview.postMessage.mock.calls
        .map((args) => args[0] as BaseMessage & { payload: { details: string } })
        .find((m) => m.type === 'bridge:error');
      expect(errorPost).toBeDefined();
      const details = (errorPost as BaseMessage & { payload: { details: string } }).payload.details;
      expect(details.length).toBeLessThanOrEqual(520);
      expect(details).toContain('…(+');
    });

    it('posts bridge:protocol-mismatch when envelope protocolVersion differs', () => {
      const telemetry = createTelemetry();
      broker = new MessageBroker({ telemetry });

      const handler = vi.fn<MessageHandler>();
      broker.on('org:list', handler);

      const panel = createMockPanel();
      broker.registerPanel(panel as unknown as vscode.WebviewPanel);

      const messageCallback = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (
        msg: unknown,
      ) => void;
      messageCallback({
        protocolVersion: PROTOCOL_VERSION + 999,
        payload: createMessage('org:list'),
      });

      const postedTypes = panel.webview.postMessage.mock.calls.map(
        (args) => (args[0] as BaseMessage).type,
      );
      expect(postedTypes).toContain('bridge:protocol-mismatch');
      // Banner NOT posted after just 1 mismatch
      expect(postedTypes).not.toContain('bridge:reload-banner');
      // Best-effort dispatch still happened
      expect(handler).toHaveBeenCalledOnce();
    });

    it('posts bridge:reload-banner after 3 consecutive protocol mismatches', () => {
      const telemetry = createTelemetry();
      broker = new MessageBroker({ telemetry });

      const panel = createMockPanel();
      broker.registerPanel(panel as unknown as vscode.WebviewPanel);
      broker.on('org:list', vi.fn());

      const messageCallback = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (
        msg: unknown,
      ) => void;
      for (let i = 0; i < 3; i++) {
        messageCallback({
          protocolVersion: PROTOCOL_VERSION + 999,
          payload: createMessage('org:list'),
        });
      }

      const postedTypes = panel.webview.postMessage.mock.calls.map(
        (args) => (args[0] as BaseMessage).type,
      );
      const mismatchCount = postedTypes.filter((t) => t === 'bridge:protocol-mismatch').length;
      const bannerCount = postedTypes.filter((t) => t === 'bridge:reload-banner').length;
      expect(mismatchCount).toBe(3);
      expect(bannerCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('unhandled message warning', () => {
    it('should log a warning when no handler is registered for a message type', () => {
      const logFn = vi.fn();
      broker.setLogFunction(logFn);

      const panel = createMockPanel();
      broker.registerPanel(panel as unknown as vscode.WebviewPanel);

      const messageCallback = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (
        msg: BaseMessage,
      ) => void;
      // Valid literal, but no handler registered for it.
      messageCallback(enveloped(createMessage('sync:execute')));

      expect(logFn).toHaveBeenCalledWith('[MessageBroker] Unhandled message type: "sync:execute"');
    });

    it('should not log a warning when a handler is registered', () => {
      const logFn = vi.fn();
      broker.setLogFunction(logFn);
      broker.on('org:list', vi.fn());

      const panel = createMockPanel();
      broker.registerPanel(panel as unknown as vscode.WebviewPanel);

      const messageCallback = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (
        msg: BaseMessage,
      ) => void;
      messageCallback(enveloped(createMessage('org:list')));

      expect(logFn).not.toHaveBeenCalledWith(expect.stringContaining('Unhandled'));
    });

    it('answers a message no handler takes with a bridge:error correlated to it', () => {
      // Without a reply the hook that sent it waits out its whole timeout and
      // then reports a generic failure.
      const panel = createMockPanel();
      broker.registerPanel(panel as unknown as vscode.WebviewPanel);

      const messageCallback = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (
        msg: BaseMessage,
      ) => void;
      messageCallback(enveloped(createMessage('sync:execute', { id: 'req-unrouted' })));

      const err = panel.webview.postMessage.mock.calls
        .map((args) => args[0] as BaseMessage & { payload: { reason: string } })
        .find((m) => m.type === 'bridge:error');
      expect(err?.correlationId).toBe('req-unrouted');
      expect(err?.payload.reason).toBe('unhandled-type');
    });
  });

  describe('rate limiting', () => {
    it('answers a dropped message with a bridge:error correlated to it', () => {
      broker = new MessageBroker({ rateLimitMax: 1 });
      const handler = vi.fn<MessageHandler>();
      broker.on('org:list', handler);
      const panel = createMockPanel();
      broker.registerPanel(panel as unknown as vscode.WebviewPanel);

      const messageCallback = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (
        msg: BaseMessage,
      ) => void;
      messageCallback(enveloped(createMessage('org:list', { id: 'req-first' })));
      messageCallback(enveloped(createMessage('org:list', { id: 'req-second' })));

      expect(handler).toHaveBeenCalledOnce();
      const errors = panel.webview.postMessage.mock.calls
        .map((args) => args[0] as BaseMessage & { payload: { reason: string } })
        .filter((m) => m.type === 'bridge:error');
      expect(errors).toHaveLength(1);
      expect(errors[0].correlationId).toBe('req-second');
      expect(errors[0].payload.reason).toBe('rate-limited');
    });
  });

  describe('showFixSuggestion', () => {
    it('hands the suggestion to the host once, whatever the number of panels', () => {
      const showFixSuggestion = vi.fn();
      broker = new MessageBroker({ showFixSuggestion });
      const panels = [createMockPanel(), createMockPanel()];
      for (const panel of panels) broker.registerPanel(panel as unknown as vscode.WebviewPanel);

      const suggestion = {
        source: 'catalogue',
        code: 'UNABLE_TO_LOCK_ROW',
        actionKey: 'errors.rowLocked.action',
      } as const;
      broker.showFixSuggestion(suggestion);

      expect(showFixSuggestion).toHaveBeenCalledOnce();
      expect(showFixSuggestion).toHaveBeenCalledWith(suggestion);
      for (const panel of panels) expect(panel.webview.postMessage).not.toHaveBeenCalled();
    });

    it('shows nothing when no host notifier was given', () => {
      const panel = createMockPanel();
      broker.registerPanel(panel as unknown as vscode.WebviewPanel);

      expect(() => broker.showFixSuggestion({ source: 'model', text: 'x' })).not.toThrow();
      expect(panel.webview.postMessage).not.toHaveBeenCalled();
    });
  });
});
