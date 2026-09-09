import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderHook } from '@testing-library/react';
import '../../i18n';
import { useAutomationPageData } from './useAutomationPageData';

/** Options captured from every useBridgeMutation call, keyed by request type. */
const mutationOptions = new Map<string, Record<string, unknown> | undefined>();

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: () => ({ data: null, loading: false, error: null, refetch: vi.fn() }),
}));

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: (type: string, options?: Record<string, unknown>) => {
    mutationOptions.set(type, options);
    return { mutate: vi.fn(), data: null, loading: false, error: null, reset: vi.fn() };
  },
}));

/** `sandforge.pipeline.timeout` default, read from the extension manifest. */
function manifestPipelineTimeoutDefault(): number {
  // vitest may be started from the workspace root or from packages/webview.
  const manifestPath = [
    resolve(process.cwd(), '../extension/package.json'),
    resolve(process.cwd(), 'packages/extension/package.json'),
  ].find((candidate) => existsSync(candidate));
  if (!manifestPath) {
    throw new Error('extension manifest not found from ' + process.cwd());
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    contributes: {
      configuration: { properties: Record<string, { default?: unknown }> };
    };
  };
  const setting = manifest.contributes.configuration.properties['sandforge.pipeline.timeout'];
  if (typeof setting?.default !== 'number') {
    throw new Error('sandforge.pipeline.timeout has no numeric default in the extension manifest');
  }
  return setting.default;
}

describe('useAutomationPageData — pipeline execution timeout', () => {
  beforeEach(() => {
    mutationOptions.clear();
  });

  it('should not give up on a run before the host does', () => {
    renderHook(() => useAutomationPageData());

    const options = mutationOptions.get('pipeline:execute');
    // A 30 s UI deadline reported a 45 s pipeline as failed while the host was
    // still running it under a 300 s budget.
    expect(options?.timeoutMs).toBe(manifestPipelineTimeoutDefault());
  });

  it('should still listen on the pipeline:run:response channel', () => {
    renderHook(() => useAutomationPageData());

    expect(mutationOptions.get('pipeline:execute')?.responseType).toBe('pipeline:run:response');
  });

  it('should read a numeric default for sandforge.pipeline.timeout from the manifest', () => {
    // Guards the assertion above: if the setting is renamed or dropped, this
    // fails loudly instead of the comparison silently passing on undefined.
    expect(manifestPipelineTimeoutDefault()).toBeGreaterThan(0);
  });
});
