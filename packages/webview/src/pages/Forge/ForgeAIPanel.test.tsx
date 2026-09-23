import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import i18n from '../../i18n';
import { ForgeAIPanel } from './ForgeAIPanel';
import type { ForgeAIPlanState, ForgeAIVerdict } from './useForgeAIPlan';

const DRAFT = "SELECT Id FROM Account WHERE Industry = 'Energy'";

function aiState(overrides: Partial<ForgeAIPlanState> = {}): ForgeAIPlanState {
  return {
    prompt: '',
    setPrompt: vi.fn(),
    draft: '',
    setDraft: vi.fn(),
    verdict: null,
    checked: false,
    stale: false,
    busy: false,
    error: null,
    notConfigured: false,
    requestDraft: vi.fn(),
    recheck: vi.fn(),
    ...overrides,
  };
}

const VERDICT: ForgeAIVerdict = {
  soql: DRAFT,
  orgId: 'org-src',
  success: true,
  rootObject: 'Account',
  rootLabel: 'Compte',
  fieldsChecked: 2,
  problems: [],
  explanation: 'Accounts in the energy industry',
};

function renderPanel(
  ai: ForgeAIPlanState,
  props: { aiAvailable?: boolean; sourceOrgId?: string } = {},
) {
  const onOpenSettings = vi.fn();
  render(
    <ForgeAIPanel
      ai={ai}
      aiAvailable={props.aiAvailable ?? true}
      sourceOrgId={props.sourceOrgId ?? 'org-src'}
      onOpenSettings={onOpenSettings}
    />,
  );
  return { onOpenSettings };
}

describe('ForgeAIPanel', () => {
  it('says how to set up a provider, and collects no prompt, when none is', () => {
    const { onOpenSettings } = renderPanel(aiState(), { aiAvailable: false });

    expect(screen.getByTestId('forge-ai-not-configured').textContent).toContain(
      i18n.t('forge.ai.notConfiguredBody'),
    );
    expect(screen.queryByTestId('forge-input-ai')).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: i18n.t('ai.notConfigured.configureButton') }),
    );
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it('says the same when the extension answered that no provider is set up', () => {
    renderPanel(aiState({ notConfigured: true }));

    expect(screen.getByTestId('forge-ai-not-configured')).toBeDefined();
  });

  it('labels the prompt, and drafts only on the button or Ctrl+Enter', () => {
    const ai = aiState({ prompt: 'energy accounts' });
    renderPanel(ai);

    const prompt = screen.getByLabelText(i18n.t('forge.ai.promptLabel'));
    fireEvent.keyDown(prompt, { key: 'Enter' });
    expect(ai.requestDraft).not.toHaveBeenCalled();
    fireEvent.keyDown(prompt, { key: 'Enter', ctrlKey: true });
    fireEvent.click(screen.getByTestId('forge-ai-draft-btn'));
    expect(ai.requestDraft).toHaveBeenCalledTimes(2);
  });

  it('waits for a source org before drafting, and says why', () => {
    renderPanel(aiState({ prompt: 'energy accounts' }), { sourceOrgId: '' });

    expect((screen.getByTestId('forge-ai-draft-btn') as HTMLButtonElement).disabled).toBe(true);
    const prompt = screen.getByLabelText(i18n.t('forge.ai.promptLabel'));
    expect(prompt.getAttribute('aria-describedby')).toBe('forge-ai-need-source');
    expect(document.getElementById('forge-ai-need-source')?.textContent).toBe(
      i18n.t('forge.ai.needSource'),
    );
  });

  it('announces the wait, and holds the button while it lasts', () => {
    renderPanel(aiState({ prompt: 'energy accounts', busy: true }));

    expect(screen.getByTestId('forge-ai-busy').textContent).toBe(i18n.t('forge.ai.busy'));
    expect((screen.getByTestId('forge-ai-draft-btn') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows a checked draft with its root object, in a labelled field the user can edit', () => {
    const ai = aiState({ draft: DRAFT, verdict: VERDICT, checked: true });
    renderPanel(ai);

    expect(screen.getByTestId('forge-ai-root').textContent).toBe(
      i18n.t('forge.ai.rootObject', { label: 'Compte', object: 'Account' }),
    );
    const query = screen.getByLabelText(i18n.t('forge.ai.queryLabel')) as HTMLTextAreaElement;
    expect(query.value).toBe(DRAFT);
    expect(screen.getByTestId('forge-ai-checked').textContent).toBe(
      i18n.t('forge.ai.checked', { object: 'Account', count: 2 }),
    );
    expect(screen.getByTestId('forge-ai-explanation').textContent).toBe(
      'Accounts in the energy industry',
    );
    expect(screen.queryByTestId('forge-ai-recheck')).toBeNull();

    fireEvent.change(query, { target: { value: `${DRAFT} LIMIT 5` } });
    expect(ai.setDraft).toHaveBeenCalledWith(`${DRAFT} LIMIT 5`);
  });

  it('says an edited draft needs checking again, and offers the check', () => {
    const ai = aiState({ draft: `${DRAFT} LIMIT 5`, verdict: VERDICT, stale: true });
    renderPanel(ai);

    expect(screen.getByTestId('forge-ai-stale').textContent).toBe(i18n.t('forge.ai.stale'));
    expect(screen.queryByTestId('forge-ai-checked')).toBeNull();
    fireEvent.click(screen.getByTestId('forge-ai-recheck'));
    expect(ai.recheck).toHaveBeenCalledOnce();
  });

  it('lists every problem the check found, each in its own sentence', () => {
    renderPanel(
      aiState({
        draft: DRAFT,
        verdict: {
          ...VERDICT,
          success: false,
          problems: [
            { kind: 'field-missing', object: 'Account', field: 'Tier__c' },
            { kind: 'relationship-missing', object: 'Account', relationship: 'Region' },
            { kind: 'org-refused', detail: 'MALFORMED_QUERY: unexpected token' },
          ],
        },
      }),
    );

    const items = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual([
      i18n.t('forge.ai.problem.fieldMissing', { object: 'Account', field: 'Tier__c' }),
      i18n.t('forge.ai.problem.relationshipMissing', { object: 'Account', relationship: 'Region' }),
      i18n.t('forge.ai.problem.orgRefused', { detail: 'MALFORMED_QUERY: unexpected token' }),
    ]);
    expect(screen.getByTestId('forge-ai-problems').getAttribute('role')).toBe('alert');
  });

  it('says why nothing came back', () => {
    renderPanel(aiState({ error: 'rate_limit_error: slow down' }));

    expect(screen.getByRole('alert').textContent).toBe(
      i18n.t('forge.ai.failed', { message: 'rate_limit_error: slow down' }),
    );
  });
});
