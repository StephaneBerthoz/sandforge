import { describe, it, expect } from 'vitest';

import { BridgeMessageSchema, CheckpointMessageSchema } from '../../bridge/messageSchemas.js';

// The shared package has no @types/node dependency — declare the two Node
// builtins this structural test needs (vitest provides both at runtime).
declare const __dirname: string;
declare function require(id: string): unknown;

const { readFileSync } = require('node:fs') as {
  readFileSync(path: string, encoding: 'utf8'): string;
};
const { join } = require('node:path') as { join(...parts: string[]): string };

/** Matches `export interface Foo extends BaseMessage { type: 'x:y';` declarations. */
const MESSAGE_IFACE_RE = /export interface (\w+) extends BaseMessage \{\s*type: '([^']+)'/g;

/**
 * The channel shape the router, the page's sent-channel guard and the
 * consumed-channel guard read (`[a-z0-9:-]`): a channel spelled otherwise —
 * `checkpoint:ignoreFields` — is invisible to the guards that prove each
 * request has a sender and a route.
 */
const CHANNEL_SHAPE = /^checkpoint(?::[a-z0-9]+(?:-[a-z0-9]+)*)+$/;

/** Every `type` literal `checkpoint.messages.ts` declares. */
function declaredLiterals(): string[] {
  const src = readFileSync(join(__dirname, 'checkpoint.messages.ts'), 'utf8');
  return [...src.matchAll(MESSAGE_IFACE_RE)].map((match) => match[2]);
}

const isReply = (literal: string): boolean => /:(response|error)$/.test(literal);

function envelope(type: string) {
  return { id: 'msg-1', type, timestamp: 1 };
}

describe('checkpoint messages', () => {
  it('declares the fifteen checkpoint requests, each with its answer', () => {
    const literals = declaredLiterals();
    const requests = literals.filter((literal) => !isReply(literal));
    expect(requests).toEqual([
      'checkpoint:list',
      'checkpoint:scope',
      'checkpoint:take',
      'checkpoint:preview',
      'checkpoint:rewind',
      'checkpoint:undo',
      'checkpoint:delete',
      'checkpoint:keep',
      'checkpoint:rename',
      'checkpoint:ignore-fields',
      'checkpoint:rewinds',
      'checkpoint:plan-selection',
      'checkpoint:export',
      'checkpoint:import-read',
      'checkpoint:import',
    ]);
    // The page's bridge hooks wait on `<request>:response` unless told otherwise.
    const unanswered = requests.filter((request) => !literals.includes(`${request}:response`));
    expect(unanswered).toEqual([]);
  });

  it("answers every refusal and failure on the domain's one error channel", () => {
    // The hooks listen on `<domain>:error` by default, correlated to the request.
    const errors = declaredLiterals().filter((literal) => literal.endsWith(':error'));
    expect(errors).toEqual(['checkpoint:error']);
  });

  it('spells every channel as the guards that prove a sender and a route read it', () => {
    const misspelt = declaredLiterals().filter((literal) => !CHANNEL_SHAPE.test(literal));
    expect(misspelt).toEqual([]);
  });

  it('lets every declared channel through the bridge, and no other of the domain', () => {
    for (const literal of declaredLiterals()) {
      expect(CheckpointMessageSchema.safeParse(envelope(literal)).success).toBe(true);
      expect(BridgeMessageSchema.safeParse(envelope(literal)).success).toBe(true);
    }
    for (const stray of [
      'checkpoint:ignoreFields',
      'checkpoint:restore',
      'checkpoint:take:error',
    ]) {
      expect(BridgeMessageSchema.safeParse(envelope(stray)).success).toBe(false);
    }
  });

  it('names no path in what the page sends to export or import a checkpoint file', () => {
    // The page's requests name a checkpoint, or the token a read answered:
    // where a file is stays with the extension, behind its dialogs.
    const src = readFileSync(join(__dirname, 'checkpoint.messages.ts'), 'utf8');
    for (const request of [
      'CheckpointExportRequest',
      'CheckpointImportReadRequest',
      'CheckpointImportRequest',
    ]) {
      const body = src.match(new RegExp(`export interface ${request} [^{]*\\{([\\s\\S]*?)\\n\\}`));
      expect(body, request).not.toBeNull();
      expect(body?.[1] ?? '', request).not.toMatch(/\b(?:path|file|folder|dir)\w*\??:/i);
    }
  });
});
