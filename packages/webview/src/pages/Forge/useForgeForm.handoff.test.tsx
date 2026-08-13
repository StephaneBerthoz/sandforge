import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

import { useForgeForm } from './useForgeForm';
import { useForgeStore } from '../../stores/useForgeStore';

/**
 * The Home hero hands a record id to the Forge form through the store.
 *
 * That write existed and nothing read it. `useForgeForm` keeps every field in
 * local state and its only mount effect hydrated `sourceOrgId`, so a user who
 * typed an 18-character id into the Home hero and pressed Start Forge landed
 * on a blank Record ID field and had to type it again — the exact journey the
 * hero exists to shorten.
 */

const CONFIG = {
  inputMode: 'record' as const,
  recordId: '001000000000001AAA',
  depth: 'direct' as const,
  sourceOrgId: '',
  targetOrgId: '',
  anonymizePII: false,
  skipEmpty: false,
  batchSize: 'auto' as const,
};

describe('useForgeForm handoff', () => {
  beforeEach(() => {
    useForgeStore.setState({ config: null });
  });

  it('adopts the record id the Home hero handed over', () => {
    useForgeStore.getState().setConfig(CONFIG);

    const { result } = renderHook(() => useForgeForm());

    expect(result.current.recordId).toBe('001000000000001AAA');
    expect(result.current.inputMode).toBe('record');
  });

  it('leaves the field empty when nothing was handed over', () => {
    const { result } = renderHook(() => useForgeForm());

    expect(result.current.recordId).toBe('');
  });
});
