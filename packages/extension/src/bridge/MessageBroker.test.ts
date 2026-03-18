import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as vscode from 'vscode';
import type { BaseMessage } from '@sandforge/shared';
import { MessageBroker } from './MessageBroker';
import type { MessageHandler } from './MessageBroker';

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

      const messageCallback = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (msg: BaseMessage) => void;
      const message = createMessage('org:list');
      messageCallback(message);

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
  });

  describe('on', () => {
    it('should register a handler for the given type', () => {
      const handler = vi.fn<MessageHandler>();
      broker.on('seed:execute', handler);

      const panel = createMockPanel();
      broker.registerPanel(panel as unknown as vscode.WebviewPanel);

      const messageCallback = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (msg: BaseMessage) => void;
      messageCallback(createMessage('seed:execute'));

      expect(handler).toHaveBeenCalledOnce();
    });

    it('should not call handler for a different message type', () => {
      const handler = vi.fn<MessageHandler>();
      broker.on('seed:execute', handler);

      const panel = createMockPanel();
      broker.registerPanel(panel as unknown as vscode.WebviewPanel);

      const messageCallback = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (msg: BaseMessage) => void;
      messageCallback(createMessage('sync:execute'));

      expect(handler).not.toHaveBeenCalled();
    });

    it('should support multiple handlers for the same type', () => {
      const handler1 = vi.fn<MessageHandler>();
      const handler2 = vi.fn<MessageHandler>();
      broker.on('org:list', handler1);
      broker.on('org:list', handler2);

      const panel = createMockPanel();
      broker.registerPanel(panel as unknown as vscode.WebviewPanel);

      const messageCallback = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (msg: BaseMessage) => void;
      messageCallback(createMessage('org:list'));

      expect(handler1).toHaveBeenCalledOnce();
      expect(handler2).toHaveBeenCalledOnce();
    });

    it('should return an unsubscribe function that removes the handler', () => {
      const handler = vi.fn<MessageHandler>();
      const unsubscribe = broker.on('org:list', handler);

      unsubscribe();

      const panel = createMockPanel();
      broker.registerPanel(panel as unknown as vscode.WebviewPanel);

      const messageCallback = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (msg: BaseMessage) => void;
      messageCallback(createMessage('org:list'));

      expect(handler).not.toHaveBeenCalled();
    });

    it('should catch errors from async handlers without crashing', async () => {
      const handler = vi.fn().mockRejectedValue(new Error('async boom'));
      broker.on('org:connect', handler);

      const panel = createMockPanel();
      broker.registerPanel(panel as unknown as vscode.WebviewPanel);

      const messageCallback = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (msg: BaseMessage) => void;
      messageCallback(createMessage('org:connect'));

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(handler).toHaveBeenCalledOnce();
      // Errors are silently caught to prevent broker crash
    });

    it('should catch errors from sync handlers without crashing', () => {
      const handler = vi.fn().mockImplementation(() => { throw new Error('sync boom'); });
      broker.on('org:list', handler);

      const panel = createMockPanel();
      broker.registerPanel(panel as unknown as vscode.WebviewPanel);

      const messageCallback = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (msg: BaseMessage) => void;
      messageCallback(createMessage('org:list'));

      expect(handler).toHaveBeenCalledOnce();
      // Errors are silently caught to prevent broker crash
    });

    it('should log errors from sync handlers via logFn', () => {
      const logFn = vi.fn();
      broker.setLogFunction(logFn);

      const handler = vi.fn().mockImplementation(() => { throw new Error('sync boom'); });
      broker.on('org:list', handler);

      const panel = createMockPanel();
      broker.registerPanel(panel as unknown as vscode.WebviewPanel);

      const messageCallback = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (msg: BaseMessage) => void;
      messageCallback(createMessage('org:list'));

      expect(logFn).toHaveBeenCalledOnce();
      expect(logFn).toHaveBeenCalledWith(
        expect.stringContaining('[MessageBroker] Handler error for "org:list": sync boom')
      );
    });

    it('should log errors from async handlers via logFn', async () => {
      const logFn = vi.fn();
      broker.setLogFunction(logFn);

      const handler = vi.fn().mockRejectedValue(new Error('async boom'));
      broker.on('org:connect', handler);

      const panel = createMockPanel();
      broker.registerPanel(panel as unknown as vscode.WebviewPanel);

      const messageCallback = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (msg: BaseMessage) => void;
      messageCallback(createMessage('org:connect'));

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(logFn).toHaveBeenCalledOnce();
      expect(logFn).toHaveBeenCalledWith(
        expect.stringContaining('[MessageBroker] Handler error for "org:connect": async boom')
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

      const messageCallback = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (msg: unknown) => void;
      messageCallback({ type: 'org:list', timestamp: Date.now() });

      expect(handler).not.toHaveBeenCalled();
      expect(logFn).toHaveBeenCalledWith(expect.stringContaining('[MessageBroker] Received malformed message'));
    });

    it('should drop messages with empty type and log error', () => {
      const logFn = vi.fn();
      broker.setLogFunction(logFn);

      const handler = vi.fn<MessageHandler>();
      broker.on('', handler);

      const panel = createMockPanel();
      broker.registerPanel(panel as unknown as vscode.WebviewPanel);

      const messageCallback = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (msg: unknown) => void;
      messageCallback({ id: 'msg-1', type: '', timestamp: Date.now() });

      expect(handler).not.toHaveBeenCalled();
      expect(logFn).toHaveBeenCalledWith(expect.stringContaining('[MessageBroker] Received malformed message'));
    });

    it('should drop messages with missing timestamp and log error', () => {
      const logFn = vi.fn();
      broker.setLogFunction(logFn);

      const handler = vi.fn<MessageHandler>();
      broker.on('org:list', handler);

      const panel = createMockPanel();
      broker.registerPanel(panel as unknown as vscode.WebviewPanel);

      const messageCallback = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (msg: unknown) => void;
      messageCallback({ id: 'msg-1', type: 'org:list' });

      expect(handler).not.toHaveBeenCalled();
      expect(logFn).toHaveBeenCalledWith(expect.stringContaining('[MessageBroker] Received malformed message'));
    });

    it('should drop null messages and log error', () => {
      const logFn = vi.fn();
      broker.setLogFunction(logFn);

      const handler = vi.fn<MessageHandler>();
      broker.on('org:list', handler);

      const panel = createMockPanel();
      broker.registerPanel(panel as unknown as vscode.WebviewPanel);

      const messageCallback = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (msg: unknown) => void;
      messageCallback(null);

      expect(handler).not.toHaveBeenCalled();
      expect(logFn).toHaveBeenCalledWith(expect.stringContaining('[MessageBroker] Received malformed message'));
    });

    it('should accept valid messages with extra payload fields', () => {
      const handler = vi.fn<MessageHandler>();
      broker.on('seed:execute', handler);

      const panel = createMockPanel();
      broker.registerPanel(panel as unknown as vscode.WebviewPanel);

      const messageCallback = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (msg: BaseMessage) => void;
      messageCallback({ id: 'msg-1', type: 'seed:execute', timestamp: Date.now(), payload: { templateId: 't1' } } as BaseMessage);

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

      const messageCallback = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (msg: BaseMessage) => void;
      messageCallback(createMessage('org:list'));

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('unhandled message warning', () => {
    it('should log a warning when no handler is registered for a message type', () => {
      const logFn = vi.fn();
      broker.setLogFunction(logFn);

      const panel = createMockPanel();
      broker.registerPanel(panel as unknown as vscode.WebviewPanel);

      const messageCallback = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (msg: BaseMessage) => void;
      messageCallback(createMessage('nonexistent:type'));

      expect(logFn).toHaveBeenCalledWith('[MessageBroker] Unhandled message type: "nonexistent:type"');
    });

    it('should not log a warning when a handler is registered', () => {
      const logFn = vi.fn();
      broker.setLogFunction(logFn);
      broker.on('org:list', vi.fn());

      const panel = createMockPanel();
      broker.registerPanel(panel as unknown as vscode.WebviewPanel);

      const messageCallback = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (msg: BaseMessage) => void;
      messageCallback(createMessage('org:list'));

      expect(logFn).not.toHaveBeenCalledWith(expect.stringContaining('Unhandled'));
    });
  });
});
