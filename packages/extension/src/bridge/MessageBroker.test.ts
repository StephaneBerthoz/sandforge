import { describe, it, expect, vi, beforeEach } from 'vitest';
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
      addBreadcrumb: ReturnType<typeof vi.fn>;
      warn: ReturnType<typeof vi.fn>;
    } {
      const warn = vi.fn();
      return {
        addBreadcrumb: vi.fn(),
        getLogger: vi.fn(() => ({ warn })),
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
  });
});
