import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BaseMessage } from '@sandforge/shared';
import { PROTOCOL_VERSION } from '@sandforge/shared';
import { MessageBroker } from './MessageBroker';
import { MessageRouter } from './MessageRouter';
import type { MessageHandler } from './MessageBroker';

function createMessage(type: string): BaseMessage {
  return {
    id: `msg-${Date.now()}`,
    type,
    timestamp: Date.now(),
  };
}

/** The broker only accepts enveloped inbound messages (raw ones are dropped). */
function enveloped(payload: BaseMessage): unknown {
  return { protocolVersion: PROTOCOL_VERSION, payload };
}

describe('MessageRouter', () => {
  let broker: MessageBroker;
  let router: MessageRouter;

  beforeEach(() => {
    broker = new MessageBroker();
    router = new MessageRouter(broker);
  });

  describe('route', () => {
    it('should register a handler on the broker for the given type', () => {
      const handler = vi.fn<MessageHandler>();
      router.route('org:list', handler);

      const brokerOnSpy = vi.spyOn(broker, 'on');
      router.route('org:connect', vi.fn());

      expect(brokerOnSpy).toHaveBeenCalledWith('org:connect', expect.any(Function));
    });

    it('should increment the route count', () => {
      expect(router.routeCount).toBe(0);

      router.route('org:list', vi.fn());
      expect(router.routeCount).toBe(1);

      router.route('seed:execute', vi.fn());
      expect(router.routeCount).toBe(2);
    });
  });

  describe('routePrefix', () => {
    it('should register handlers only for types matching the prefix', () => {
      const handler = vi.fn<MessageHandler>();
      const types = ['org:list', 'org:connect', 'seed:execute', 'org:disconnect'];

      router.routePrefix('org:', types, handler);

      expect(router.routeCount).toBe(3);
    });

    it('should not register any routes if no types match the prefix', () => {
      const handler = vi.fn<MessageHandler>();
      const types = ['seed:execute', 'sync:execute'];

      router.routePrefix('org:', types, handler);

      expect(router.routeCount).toBe(0);
    });
  });

  describe('routeAll', () => {
    it('should register handlers for all provided type-handler pairs', () => {
      const orgHandler = vi.fn<MessageHandler>();
      const seedHandler = vi.fn<MessageHandler>();
      const syncHandler = vi.fn<MessageHandler>();

      router.routeAll({
        'org:list': orgHandler,
        'seed:execute': seedHandler,
        'sync:execute': syncHandler,
      });

      expect(router.routeCount).toBe(3);
    });

    it('should dispatch messages to the correct handlers via the broker', () => {
      const orgHandler = vi.fn<MessageHandler>();
      const seedHandler = vi.fn<MessageHandler>();

      router.routeAll({
        'org:list': orgHandler,
        'seed:execute': seedHandler,
      });

      // Simulate a dispatched message by using the broker's on mechanism
      // We need to trigger the broker's internal dispatch, so we use a mock panel
      const mockPanel = {
        webview: {
          onDidReceiveMessage: vi.fn().mockReturnValue({ dispose: vi.fn() }),
          postMessage: vi.fn(),
        },
      };
      broker.registerPanel(mockPanel as never);

      const messageCallback = mockPanel.webview.onDidReceiveMessage.mock.calls[0][0] as (
        msg: BaseMessage,
      ) => void;

      messageCallback(enveloped(createMessage('org:list')) as unknown as BaseMessage);
      expect(orgHandler).toHaveBeenCalledOnce();
      expect(seedHandler).not.toHaveBeenCalled();

      messageCallback(enveloped(createMessage('seed:execute')) as unknown as BaseMessage);
      expect(seedHandler).toHaveBeenCalledOnce();
    });
  });

  describe('admission', () => {
    it('hands each handler the dispatched message frozen, so the id it answers cannot be rewritten', () => {
      let received: BaseMessage | undefined;
      router.route('org:list', (msg) => {
        received = msg;
      });
      const mockPanel = {
        webview: {
          onDidReceiveMessage: vi.fn().mockReturnValue({ dispose: vi.fn() }),
          postMessage: vi.fn(),
        },
      };
      broker.registerPanel(mockPanel as never);
      const deliver = mockPanel.webview.onDidReceiveMessage.mock.calls[0][0] as (
        raw: unknown,
      ) => void;

      deliver(enveloped(createMessage('org:list')));

      expect(received?.type).toBe('org:list');
      expect(Object.isFrozen(received)).toBe(true);
      expect(() => {
        (received as { id: string }).id = '';
      }).toThrow(TypeError);
    });
  });

  describe('dispose', () => {
    it('should unsubscribe all registered routes from the broker', () => {
      const handler = vi.fn<MessageHandler>();
      router.route('org:list', handler);
      router.route('seed:execute', handler);

      expect(router.routeCount).toBe(2);

      router.dispose();

      expect(router.routeCount).toBe(0);
    });

    it('should prevent disposed routes from receiving messages', () => {
      const handler = vi.fn<MessageHandler>();
      router.route('org:list', handler);

      router.dispose();

      const mockPanel = {
        webview: {
          onDidReceiveMessage: vi.fn().mockReturnValue({ dispose: vi.fn() }),
          postMessage: vi.fn(),
        },
      };
      broker.registerPanel(mockPanel as never);

      const messageCallback = mockPanel.webview.onDidReceiveMessage.mock.calls[0][0] as (
        msg: BaseMessage,
      ) => void;
      messageCallback(enveloped(createMessage('org:list')) as unknown as BaseMessage);

      expect(handler).not.toHaveBeenCalled();
    });
  });
});
