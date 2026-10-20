import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as vscode from 'vscode';
import { PROTOCOL_VERSION } from '@sandforge/shared';
import type { BaseMessage } from '@sandforge/shared';
import { MessageBroker } from '../MessageBroker.js';
import { I18nHandler } from './I18nHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import { inboundRequest } from '../../test/mockFactories.js';

/** A webview registered on the broker: what it was sent, and how it sends. */
interface FakeWebview {
  posted: BaseMessage[];
  ask: (id: string, lng: string) => void;
}

let dir: string;
let broker: MessageBroker;

function webview(): FakeWebview {
  const fake: FakeWebview = { posted: [], ask: () => undefined };
  let deliver: (raw: unknown) => void = () => undefined;
  broker.registerPanel({
    webview: {
      postMessage: (message: BaseMessage) => {
        fake.posted.push(message);
        return Promise.resolve(true);
      },
      onDidReceiveMessage: (listener: (raw: unknown) => void) => {
        deliver = listener;
        return { dispose: () => undefined };
      },
    },
  } as unknown as vscode.WebviewPanel);
  fake.ask = (id, lng) =>
    deliver({
      protocolVersion: PROTOCOL_VERSION,
      payload: { id, type: 'i18n:locale', timestamp: Date.now(), payload: { lng } },
    });
  return fake;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'i18n-handler-'));
  await writeFile(join(dir, 'fr.json'), JSON.stringify({ nav: { seed: 'Seed' } }));
  broker = new MessageBroker();
  let ids = 0;
  const deps = {
    broker,
    log: vi.fn(),
    nextId: () => `ext-${++ids}`,
  } as unknown as HandlerDeps;
  const handler = new I18nHandler(deps, dir);
  broker.on('i18n:locale', async (message) => {
    await handler.handle(inboundRequest(message));
  });
});

afterEach(async () => {
  broker.dispose();
  await rm(dir, { recursive: true, force: true });
});

describe('I18nHandler', () => {
  it('answers a locale request to the panel that made it, and to no other', async () => {
    const asking = webview();
    const other = webview();
    const sidebar: BaseMessage[] = [];
    broker.registerPanel(
      {
        webview: {
          postMessage: (message: BaseMessage) => {
            sidebar.push(message);
            return Promise.resolve(true);
          },
          onDidReceiveMessage: () => ({ dispose: () => undefined }),
        },
      } as unknown as vscode.WebviewView,
      { inbound: false },
    );

    asking.ask('wv-locale-1', 'fr');

    await vi.waitFor(() => expect(asking.posted).toHaveLength(1));
    expect(asking.posted[0]).toMatchObject({
      type: 'i18n:locale:response',
      correlationId: 'wv-locale-1',
      payload: { lng: 'fr', bundle: { nav: { seed: 'Seed' } } },
    });
    expect(other.posted).toEqual([]);
    expect(sidebar).toEqual([]);
  });

  it('answers a language with no catalogue with an error, to the panel that asked', async () => {
    const asking = webview();
    const other = webview();

    asking.ask('wv-locale-2', 'de');

    await vi.waitFor(() => expect(asking.posted).toHaveLength(1));
    expect(asking.posted[0]).toMatchObject({
      type: 'i18n:locale:response',
      correlationId: 'wv-locale-2',
      payload: { lng: 'de' },
    });
    expect(
      (asking.posted[0] as BaseMessage & { payload: { error?: string } }).payload.error,
    ).toBeTruthy();
    expect(other.posted).toEqual([]);
  });
});
