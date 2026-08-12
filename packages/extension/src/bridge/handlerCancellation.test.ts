import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

import { BackgroundOperationRegistry } from '../core/engine/BackgroundOperationRegistry.js';

/**
 * Cancellation guard.
 *
 * SeedCloneHandler, SeedCsvHandler and FrozenDatasetHandler each passed
 * `new AbortController().signal` to BulkDataWriter. Nothing held a reference to
 * that controller, so `.abort()` could never be called on it, and because the
 * operation was never registered, `execution:abort` answered "Operation not
 * found" and the bulk write ran to completion. Cancelling a long load was a
 * button that did nothing.
 *
 * A handler that writes through BulkDataWriter must hold a real controller and
 * register it, so the abort path can reach it.
 */

const HANDLERS_DIR = join(__dirname, 'handlers');

/** Handler sources, keyed by file name. */
function handlerSources(): Map<string, string> {
  const sources = new Map<string, string>();
  for (const file of readdirSync(HANDLERS_DIR)) {
    if (!file.endsWith('.ts') || file.includes('.test.')) continue;
    sources.set(file, readFileSync(join(HANDLERS_DIR, file), 'utf8'));
  }
  return sources;
}

describe('handler cancellation wiring', () => {
  it('finds the handler sources it is meant to guard', () => {
    // Guards the guard: an empty scan would pass every assertion below.
    expect(handlerSources().size).toBeGreaterThan(15);
  });

  it('never hands a throwaway AbortController to a writer', () => {
    const throwaway: string[] = [];
    for (const [file, src] of Array.from(handlerSources())) {
      if (/signal:\s*new AbortController\(\)\.signal/.test(src)) throwaway.push(file);
    }

    expect(throwaway).toEqual([]);
  });

  it('registers every handler that constructs a BulkDataWriter', () => {
    // Registration is what makes execution:abort able to find the operation;
    // holding a controller privately would still leave the run uncancellable.
    const unregistered: string[] = [];
    for (const [file, src] of Array.from(handlerSources())) {
      if (!src.includes('new BulkDataWriter(')) continue;
      if (!src.includes('setRegistry(')) unregistered.push(file);
    }

    expect(unregistered).toEqual([]);
  });

  it('aborts the signal a registered operation was created with', async () => {
    // The behaviour the wiring above is for: registry.abort(id) must fire the
    // very signal the writer is watching.
    const registry = new BackgroundOperationRegistry();
    const controller = new AbortController();
    let settle: () => void = () => {};
    const tracked = new Promise<void>((resolve) => {
      settle = resolve;
    });

    registry.register('op-1', 'clone', 'Clone 2 object(s)', tracked, controller);
    expect(controller.signal.aborted).toBe(false);

    registry.abort('op-1');
    expect(controller.signal.aborted).toBe(true);

    settle();
    await tracked;
  });
});
