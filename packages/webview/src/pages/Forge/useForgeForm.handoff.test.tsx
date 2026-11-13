import { StrictMode } from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { SalesforceOrg } from '@sandforge/shared';

import { useForgeForm } from './useForgeForm';
import { useForgeStore } from '../../stores/useForgeStore';
import { useOrgStore } from '../../stores/useOrgStore';

/**
 * The Home hero hands a record id to the Forge form through the store, where
 * ForgePage puts it as it opens (ForgePage.handoff.test.tsx).
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

/**
 * The results of a clone of the whole org taken up from the history hand the
 * form ALL and the orgs it ran between: its graph has no relations to run by,
 * and Retry offered there was refused every time.
 */
describe('useForgeForm, a clone of the whole org asked for again', () => {
  const PRODUCTION = {
    id: 'org-prod',
    alias: 'prod',
    username: 'admin@prod.example.invalid',
    orgType: 'Production',
  } as SalesforceOrg;
  const SANDBOX = {
    id: 'org-sbx',
    alias: 'sbx',
    username: 'admin@sbx.example.invalid',
    orgType: 'Sandbox',
  } as SalesforceOrg;
  const PANEL_ORG = { ...SANDBOX, id: 'org-panel', alias: 'panel' } as SalesforceOrg;

  beforeEach(() => {
    useForgeStore.getState().reset();
    useOrgStore.setState({ orgs: [PRODUCTION, SANDBOX, PANEL_ORG], selectedOrgId: PANEL_ORG.id });
  });

  it('opens on ALL between the orgs it ran between, Anonymize PII on for a production source', () => {
    useForgeStore
      .getState()
      .cloneWholeOrgAgain({ sourceOrgId: PRODUCTION.id, targetOrgId: SANDBOX.id });

    const { result } = renderHook(() => useForgeForm(), { wrapper: StrictMode });

    expect(result.current.depth).toBe('all');
    expect(result.current.wholeOrg).toBe(true);
    // The org the panel selected was taken first, and again on the second
    // pass of the effects development makes.
    expect(result.current.sourceOrgId).toBe(PRODUCTION.id);
    expect(result.current.targetOrgId).toBe(SANDBOX.id);
    expect(result.current.anonymize).toBe(true);
    expect(useForgeStore.getState().wholeOrgAgain).toBeNull();
  });

  it('keeps the org the panel selected when the run’s source is no longer held', () => {
    useForgeStore
      .getState()
      .cloneWholeOrgAgain({ sourceOrgId: 'org-gone', targetOrgId: undefined });

    const { result } = renderHook(() => useForgeForm());

    expect(result.current.depth).toBe('all');
    expect(result.current.sourceOrgId).toBe(PANEL_ORG.id);
    expect(result.current.targetOrgId).toBe('');
    expect(result.current.anonymize).toBe(false);
  });

  it('opens on a new run’s depth once the form has taken it', () => {
    useForgeStore
      .getState()
      .cloneWholeOrgAgain({ sourceOrgId: PRODUCTION.id, targetOrgId: SANDBOX.id });
    renderHook(() => useForgeForm()).unmount();

    const { result } = renderHook(() => useForgeForm());

    expect(result.current.depth).toBe('direct');
  });
});
