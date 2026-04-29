import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { ForgeTemplates } from './ForgeTemplates';
import type { ForgeTemplate } from '../../stores/useForgeStore';

/* ---- Mocks ---- */

const mockSetConfig = vi.fn();
const mockSetPhase = vi.fn();

const sampleTemplate: ForgeTemplate = {
  id: 'tpl-001',
  name: 'Account Clone',
  description: 'Clones accounts with contacts',
  config: {
    inputMode: 'record',
    depth: 'full',
    recordId: '001XXXXXXXXXXXX',
    anonymizePII: false,
    skipEmpty: false,
    batchSize: 'auto',
  },
  objectCount: 2,
  recordCount: 100,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastUsedAt: '2026-03-01T00:00:00.000Z',
};

let mockTemplates: ForgeTemplate[] = [];

vi.mock('../../stores/useForgeStore', () => {
  const store = Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        get templates() { return mockTemplates; },
        setConfig: (...args: unknown[]) => mockSetConfig(...args),
        setPhase: (...args: unknown[]) => mockSetPhase(...args),
      }),
    {
      getState: () => ({
        templates: mockTemplates,
        setConfig: mockSetConfig,
        setPhase: mockSetPhase,
      }),
    },
  );
  return { useForgeStore: store };
});

vi.mock('../../components/ui/DangerConfirm', () => ({
  DangerConfirm: ({ open, onConfirm }: { open: boolean; onConfirm: () => void }) =>
    open ? (
      <div data-testid="danger-confirm-mock">
        <button data-testid="danger-confirm-ok" onClick={onConfirm}>Confirm</button>
      </div>
    ) : null,
}));

/* ---- Tests ---- */

describe('ForgeTemplates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTemplates = [];
  });

  it('should render builtin starter templates even when no user templates exist', () => {
    render(<ForgeTemplates />);
    expect(screen.getByTestId('forge-templates')).toBeDefined();
    // Builtins always render — Account 360 / Case Workflow / Lead → Opportunity
    const builtins = screen.getAllByTestId('forge-template-builtin');
    expect(builtins.length).toBeGreaterThanOrEqual(3);
  });

  it('should render template list when templates exist', () => {
    mockTemplates = [sampleTemplate];
    render(<ForgeTemplates />);
    expect(screen.getByTestId('forge-templates')).toBeDefined();
    expect(screen.getByText('Account Clone')).toBeDefined();
    expect(screen.getByText('Clones accounts with contacts')).toBeDefined();
  });

  it('should render use button on every template and delete only on user-saved ones', () => {
    mockTemplates = [sampleTemplate];
    render(<ForgeTemplates />);
    // 3 builtins + 1 user-saved = at least 4 use buttons
    expect(screen.getAllByTestId('forge-use-template').length).toBeGreaterThanOrEqual(4);
    // Only the user-saved one shows a delete button
    const deletes = screen.getAllByTestId('forge-delete-template');
    expect(deletes.length).toBe(1);
  });

  it('should set config and navigate to discovery when a user use template is clicked', () => {
    mockTemplates = [sampleTemplate];
    render(<ForgeTemplates />);
    // Builtins come first; the user template is last in the list
    const useButtons = screen.getAllByTestId('forge-use-template');
    fireEvent.click(useButtons[useButtons.length - 1]);
    expect(mockSetConfig).toHaveBeenCalledWith({
      ...sampleTemplate.config,
      sourceOrgId: '',
      targetOrgId: '',
    });
    expect(mockSetPhase).toHaveBeenCalledWith('input');
  });

  it('should open delete confirmation when delete is clicked', () => {
    mockTemplates = [sampleTemplate];
    render(<ForgeTemplates />);
    fireEvent.click(screen.getByTestId('forge-delete-template'));
    expect(screen.getByTestId('danger-confirm-mock')).toBeDefined();
  });

  it('should render multiple template rows', () => {
    mockTemplates = [
      sampleTemplate,
      { ...sampleTemplate, name: 'Opportunity Clone', description: 'Clone opps' },
    ];
    render(<ForgeTemplates />);
    const rows = screen.getAllByTestId('forge-template-row');
    expect(rows.length).toBe(2);
  });
});
