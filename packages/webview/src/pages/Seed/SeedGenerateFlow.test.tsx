import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { OrgSafetyTier } from '@sandforge/shared';
import type { SalesforceOrg } from '@sandforge/shared';
import { SeedGenerateFlow } from './SeedGenerateFlow';

const mockPostMessage = vi.fn();
const vscodeApi = {
  postMessage: mockPostMessage,
  getState: () => undefined,
  setState: () => undefined,
};

vi.mock('../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => vscodeApi,
  getVscodeApi: () => vscodeApi,
}));

/* The steps' own content is covered by their tests. */
vi.mock('./SeedSelectStep', () => ({
  SeedSelectStep: () => <div data-testid="seed-step-select-content" />,
}));
vi.mock('./SeedExecuteStep', () => ({
  SeedExecuteStep: () => <div data-testid="seed-step-execute-content" />,
}));
vi.mock('./Persona/PersonaGallery', () => ({ PersonaGallery: () => null }));

const ORG: SalesforceOrg = {
  id: 'org-1',
  alias: 'dev1',
  username: 'user@dev1.com',
  instanceUrl: 'https://dev1.salesforce.com',
  orgId: '00D000000000001',
  orgType: 'Sandbox',
  authMethod: 'oauth_web',
  safetyTier: OrgSafetyTier.LOW,
  appearance: { color: '#0070d2', icon: 'cloud', position: 0 },
  metadata: { apiVersion: '59.0', edition: 'Developer Edition', features: [] },
  status: 'connected',
  lastConnected: '2024-01-01T00:00:00Z',
  tags: [],
};

/** The wizard facade, on a step of its own. */
const wizard = vi.hoisted(() => ({ step: 0, error: null as string | null }));
vi.mock('./useSeedWizardState', () => ({
  useSeedWizardState: () => ({
    currentStep: wizard.step,
    setCurrentStep: vi.fn(),
    canGoNext: false,
    isFinished: false,
    selectedOrg: ORG,
    selectedOrgId: 'org-1',
    selectedObjects: [],
    error: wizard.error,
    setError: vi.fn(),
    isRunning: false,
    operationId: null,
    executionResult: undefined,
    handleExecute: vi.fn(),
    objectProgress: [],
    overallPercent: 0,
    elapsedMs: 0,
    selectedPersona: null,
  }),
}));

describe('SeedGenerateFlow', () => {
  beforeEach(() => {
    wizard.step = 0;
    wizard.error = null;
    mockPostMessage.mockClear();
  });

  it('heads the wizard with its step and the org it writes to, and goes back on request', () => {
    const onBack = vi.fn();
    render(<SeedGenerateFlow active onBack={onBack} />);

    const header = screen.getByTestId('page-header');
    expect(header.textContent).toContain('Seed Data');
    expect(header.textContent).toContain('Seed DataSelect');
    expect(header.textContent).toContain('dev1');
    expect(screen.getByTestId('seed-step-select-content')).toBeDefined();
    expect(screen.getByTestId('seed-persona-choice')).toBeDefined();

    fireEvent.click(screen.getByTestId('back-to-modes'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('says the wizard’s error above it', () => {
    wizard.error = 'Connection failed';
    render(<SeedGenerateFlow active onBack={vi.fn()} />);

    expect(screen.getByTestId('seed-error').textContent).toContain('Connection failed');
  });

  it('stays mounted and hidden while the page shows another way, with no header of its own', () => {
    // A run the wizard started goes on reporting to it: unmounted, its
    // progress and results would be lost on return.
    wizard.step = 2;
    render(<SeedGenerateFlow active={false} onBack={vi.fn()} />);

    const flow = screen.getByTestId('seed-generate-flow');
    expect(flow.parentElement?.hidden).toBe(true);
    expect(screen.getByTestId('seed-step-execute-content')).toBeDefined();
    expect(screen.queryByTestId('page-header')).toBeNull();
    expect(screen.queryByTestId('back-to-modes')).toBeNull();
  });
});
