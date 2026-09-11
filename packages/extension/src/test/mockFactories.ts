/**
 * Shared mock factories for extension tests.
 *
 * Centralizes the recurring partial-mock patterns so the (intentional) casts
 * live in exactly one reviewed place instead of being scattered across test
 * files. Factories expose the underlying `vi.fn()` mocks so tests can assert
 * on calls without extra casts.
 *
 * This file lives under `src/test/` so Vitest does NOT pick it up as a test
 * file (no `.test.ts` suffix). It is a pure test helper module.
 */
import { vi, type Mock } from 'vitest';
import type { BaseMessage } from '@sandforge/shared';
import type { MessageBroker } from '../bridge/MessageBroker.js';
import type { InboundRequest } from '../bridge/handlers/HandlerTypes.js';

/**
 * A `MessageBroker` mock whose `postToWebview` is a real `vi.fn()` that tests
 * can assert on (`.mock.calls`, `toHaveBeenCalledWith`, ...).
 */
export interface MockBroker extends MessageBroker {
  postToWebview: Mock<(message: BaseMessage) => void>;
}

/**
 * Creates a partial `MessageBroker` mock: only `postToWebview` is implemented.
 * Tests using this factory never touch the other broker members — the cast is
 * localized here so test files stay clean.
 */
export function createMockBroker(): MockBroker {
  // Partial mock by design: only postToWebview is exercised by consumers.
  return { postToWebview: vi.fn() } as unknown as MockBroker;
}

/**
 * Stand-in for a request the MessageRouter delivered.
 *
 * Production code obtains an `InboundRequest` only from the router or from
 * `syntheticRequest`; a test answering a hand-written request mints one here,
 * in the one reviewed place, instead of casting at every call site.
 */
export function inboundRequest<M extends BaseMessage>(message: M): M & InboundRequest {
  return message as M & InboundRequest;
}
