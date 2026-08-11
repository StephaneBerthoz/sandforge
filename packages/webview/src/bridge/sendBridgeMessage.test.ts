import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { BaseMessage } from '@sandforge/shared';
import { PROTOCOL_VERSION } from '@sandforge/shared';

const mockPostMessage = vi.fn();

vi.mock('../hooks/useVSCodeApi', () => ({
  getVscodeApi: () => ({
    postMessage: mockPostMessage,
    getState: () => undefined,
    setState: () => undefined,
  }),
}));

import { sendBridgeMessage, postEnvelopedMessage } from './sendBridgeMessage';

/** Shape of the envelope as posted to the extension host. */
interface PostedEnvelope {
  protocolVersion: number;
  correlationId?: string;
  payload: BaseMessage & { payload?: Record<string, unknown> };
}

function lastEnvelope(): PostedEnvelope {
  return mockPostMessage.mock.calls[mockPostMessage.mock.calls.length - 1][0] as PostedEnvelope;
}

describe('sendBridgeMessage', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
  });

  it('wraps a payload-less message in the protocol envelope', () => {
    sendBridgeMessage('sync:history:list');

    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    const envelope = lastEnvelope();
    expect(envelope.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(envelope.payload.type).toBe('sync:history:list');
    expect(envelope.payload.id).toMatch(/^wv-/);
    expect(typeof envelope.payload.timestamp).toBe('number');
    expect(envelope.payload.payload).toBeUndefined();
  });

  it('attaches the payload to the inner message, not the envelope', () => {
    sendBridgeMessage('sync:history:rerun', { entryId: 'h-1' });

    const envelope = lastEnvelope();
    expect(envelope.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(envelope.payload.type).toBe('sync:history:rerun');
    expect(envelope.payload.payload).toEqual({ entryId: 'h-1' });
  });

  it('generates unique message ids across calls', () => {
    sendBridgeMessage('realtime:metrics');
    const first = lastEnvelope();
    sendBridgeMessage('realtime:metrics');
    const second = lastEnvelope();

    expect(first.payload.id).not.toBe(second.payload.id);
  });
});

describe('postEnvelopedMessage', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
  });

  it('posts the exact envelope shape useSendMessage produces', () => {
    const message: BaseMessage = { id: 'm-1', type: 'org:list', timestamp: 123 };

    postEnvelopedMessage(message);

    expect(mockPostMessage).toHaveBeenCalledWith({
      protocolVersion: PROTOCOL_VERSION,
      correlationId: undefined,
      payload: message,
    });
  });

  it('propagates the message correlationId to the envelope', () => {
    const message: BaseMessage = {
      id: 'm-2',
      type: 'org:list',
      timestamp: 456,
      correlationId: 'req-42',
    };

    postEnvelopedMessage(message);

    expect(mockPostMessage).toHaveBeenCalledWith({
      protocolVersion: PROTOCOL_VERSION,
      correlationId: 'req-42',
      payload: message,
    });
  });
});
