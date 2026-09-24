import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import type { BaseMessage } from '@sandforge/shared';
import i18n from '../../i18n';
import { useAppStore } from '../../stores/useAppStore';
import { ForgeInput } from './ForgeInput';
import { SOQL_UNSCOPED_RECORD_CAP } from './forgeUtils';

/* ---- Bridge double: what the form posts, and a way to answer it ---- */

const mockPostMessage = vi.fn();
const stableApi = {
  postMessage: (...args: unknown[]) => mockPostMessage(...args),
  getState: () => undefined,
  setState: () => undefined,
};
vi.mock('../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => stableApi,
  getVscodeApi: () => stableApi,
}));

/** The payloads of every message of `type` the form posted. */
function sent<T>(type: string): T[] {
  return mockPostMessage.mock.calls
    .map((call) => call[0] as { payload: BaseMessage & { payload: T } })
    .filter((envelope) => envelope.payload.type === type)
    .map((envelope) => envelope.payload.payload);
}

/** Answer the last `requestType` message the form posted, the way the handler does. */
function replyTo(requestType: string, payload: unknown): void {
  const request = mockPostMessage.mock.calls
    .map((call) => call[0] as { payload: BaseMessage })
    .filter((envelope) => envelope.payload.type === requestType)
    .pop();
  if (!request) throw new Error(`no '${requestType}' message was sent`);
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          id: `resp-${requestType}`,
          type: `${requestType}:response`,
          timestamp: Date.now(),
          correlationId: request.payload.id,
          payload,
        },
      }),
    );
  });
}

/* ---- Store mocks ---- */

const mockSetConfig = vi.fn();
const mockSetPhase = vi.fn();
const mockSetTemplates = vi.fn();
const mockUpsertTemplate = vi.fn();
const mockRemoveTemplate = vi.fn();
const mockSetAnonymizationRules = vi.fn();
const mockSetAnonymizationPresetId = vi.fn();

/* Mutable user-template list — tests push into it before rendering. */
const mockTemplates = vi.hoisted(() => ({ list: [] as Array<Record<string, unknown>> }));

vi.mock('../../stores/useForgeStore', () => {
  const defaultState = {
    phase: 'input' as const,
    config: null,
    templates: mockTemplates.list,
    graph: null,
    result: null,
    history: [],
    setConfig: (...args: unknown[]) => mockSetConfig(...args),
    setPhase: (...args: unknown[]) => mockSetPhase(...args),
    setTemplates: (...args: unknown[]) => mockSetTemplates(...args),
    upsertTemplate: (...args: unknown[]) => mockUpsertTemplate(...args),
    removeTemplate: (...args: unknown[]) => mockRemoveTemplate(...args),
    setAnonymizationRules: (...args: unknown[]) => mockSetAnonymizationRules(...args),
    setAnonymizationPresetId: (...args: unknown[]) => mockSetAnonymizationPresetId(...args),
    setGraph: vi.fn(),
    updateNodeStatus: vi.fn(),
    toggleNodeIncluded: vi.fn(),
    toggleAnonymizeField: vi.fn(),
    reset: vi.fn(),
  };

  const store = Object.assign(
    (selector: (state: typeof defaultState) => unknown) => selector(defaultState),
    { getState: () => defaultState },
  );

  return { useForgeStore: store };
});

vi.mock('../../stores/useNotificationStore', () => ({
  useNotificationStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ addNotification: vi.fn() }),
}));

vi.mock('../../components/ui/DangerConfirm', () => ({
  DangerConfirm: ({
    open,
    onConfirm,
    title,
  }: {
    open: boolean;
    onConfirm: () => void;
    title: string;
  }) =>
    open ? (
      <div data-testid="danger-confirm">
        <span>{title}</span>
        <button onClick={onConfirm}>Confirm</button>
      </div>
    ) : null,
}));

vi.mock('../../stores/useOrgStore', () => ({
  useOrgStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      orgs: [
        {
          id: 'org-src',
          alias: 'SourceOrg',
          username: 'src@test.com',
          instanceUrl: 'https://src.salesforce.com',
          status: 'connected',
          orgType: 'Sandbox',
          safetyTier: 'low',
        },
        {
          id: 'org-tgt',
          alias: 'TargetOrg',
          username: 'tgt@test.com',
          instanceUrl: 'https://tgt.salesforce.com',
          status: 'connected',
          orgType: 'Sandbox',
          safetyTier: 'low',
        },
      ],
      selectedOrgId: 'org-src',
    }),
}));

/* ---- Tests ---- */

/** Helper to select an org from the OrgDropdown custom component.
 * Use orgId='empty' to select the placeholder (clear selection).
 */
function selectOrg(testId: string, orgId: string): void {
  const trigger = screen.getByTestId(testId);
  fireEvent.click(trigger);
  const optionTestId = orgId === 'empty' ? `${testId}-option-empty` : `${testId}-option-${orgId}`;
  fireEvent.click(screen.getByTestId(optionTestId));
}

describe('ForgeInput', () => {
  beforeEach(() => {
    mockSetConfig.mockClear();
    mockSetPhase.mockClear();
    mockSetTemplates.mockClear();
    mockUpsertTemplate.mockClear();
    mockRemoveTemplate.mockClear();
    mockSetAnonymizationRules.mockClear();
    mockSetAnonymizationPresetId.mockClear();
    mockPostMessage.mockClear();
    mockTemplates.list.length = 0;
  });

  afterEach(() => {
    useAppStore.setState({ aiAvailable: false });
  });

  it('should render 4 tabs', () => {
    render(<ForgeInput />);
    expect(screen.getByTestId('forge-tab-record')).toBeDefined();
    expect(screen.getByTestId('forge-tab-soql')).toBeDefined();
    expect(screen.getByTestId('forge-tab-template')).toBeDefined();
    expect(screen.getByTestId('forge-tab-ai')).toBeDefined();
  });

  describe('the AI tab', () => {
    const DRAFT = "SELECT Id, Name FROM Account WHERE Industry = 'Energy'";

    /** Open the AI tab with a provider set up and a target picked. */
    function openAiTab(): void {
      useAppStore.setState({ aiAvailable: true });
      render(<ForgeInput />);
      selectOrg('forge-target-org', 'org-tgt');
      fireEvent.mouseDown(screen.getByTestId('forge-tab-ai'));
    }

    /** Draft from a prompt, and answer with a verdict. */
    function draftAndAnswer(payload: Record<string, unknown>): void {
      fireEvent.change(screen.getByTestId('forge-input-ai'), {
        target: { value: 'energy accounts' },
      });
      fireEvent.click(screen.getByTestId('forge-ai-draft-btn'));
      replyTo('ai:forge-plan', payload);
    }

    const CHECKED = {
      success: true,
      soql: DRAFT,
      explanation: 'Accounts in the energy industry',
      rootObject: 'Account',
      rootLabel: 'Account',
      fieldsChecked: 3,
      problems: [],
    };

    it('opens, and says how to set up a provider when none is', () => {
      const navigate = vi.fn();
      useAppStore.setState({ navigate });
      render(<ForgeInput />);
      const aiTab = screen.getByTestId('forge-tab-ai') as HTMLButtonElement;

      expect(aiTab.disabled).toBe(false);
      expect(aiTab.textContent).not.toContain(i18n.t('common.comingSoon'));
      fireEvent.mouseDown(aiTab);

      expect(screen.getByTestId('forge-ai-not-configured').textContent).toContain(
        i18n.t('forge.ai.notConfiguredTitle'),
      );
      expect(screen.queryByTestId('forge-input-ai')).toBeNull();
      fireEvent.click(screen.getByTestId('forge-ai-open-settings'));
      expect(navigate).toHaveBeenCalledWith('settings');
    });

    it('sends the prompt to be drafted against the source org, and runs nothing', () => {
      openAiTab();

      draftAndAnswer(CHECKED);

      expect(sent<Record<string, unknown>>('ai:forge-plan')).toEqual([
        { orgId: 'org-src', prompt: 'energy accounts' },
      ]);
      expect((screen.getByTestId('forge-ai-query') as HTMLTextAreaElement).value).toBe(DRAFT);
      expect(screen.getByTestId('forge-ai-root').textContent).toBe(
        i18n.t('forge.ai.rootObject', { label: 'Account', object: 'Account' }),
      );
      expect(screen.getByTestId('forge-ai-checked').textContent).toBe(
        i18n.t('forge.ai.checked', { object: 'Account', count: 3 }),
      );
      // Checked is not run: discovery waits for the user's click.
      expect(mockSetConfig).not.toHaveBeenCalled();
      expect(sent('forge:discover')).toEqual([]);
    });

    it('discovers from the checked draft as the SOQL run it is, on the click', () => {
      openAiTab();
      draftAndAnswer(CHECKED);
      fireEvent.change(screen.getByTestId('forge-record-limit'), { target: { value: 'all' } });

      fireEvent.click(screen.getByTestId('forge-discover-btn'));

      expect(mockSetConfig).toHaveBeenCalledTimes(1);
      const config = mockSetConfig.mock.calls[0][0];
      expect(config.inputMode).toBe('soql');
      expect(config.soqlQuery).toBe(DRAFT);
      expect(config.objectSoqlFilters).toEqual({ Account: "Industry = 'Energy'" });
      // The WHERE clause narrows the root only, so "All" stays capped as in the SOQL tab.
      expect(config.maxRecordsPerObject).toBe(SOQL_UNSCOPED_RECORD_CAP);
      expect(sent<{ config: { inputMode: string } }>('forge:discover')[0].config.inputMode).toBe(
        'soql',
      );
      expect(mockSetPhase).toHaveBeenCalledWith('discovery');
    });

    it('holds discovery back once the checked query is edited, until it is checked again', () => {
      openAiTab();
      draftAndAnswer(CHECKED);
      const edited = "SELECT Id, Name FROM Account WHERE Industry = 'Energy' AND Rating = 'Hot'";

      fireEvent.change(screen.getByTestId('forge-ai-query'), { target: { value: edited } });

      expect(screen.getByTestId('forge-ai-stale')).toBeDefined();
      expect((screen.getByTestId('forge-discover-btn') as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByTestId('forge-discover-hint').textContent).toBe(
        i18n.t('forge.hintAiUnchecked'),
      );

      fireEvent.click(screen.getByTestId('forge-ai-recheck'));
      // A check of an edited query goes without the prompt: the model is not asked again.
      expect(sent<Record<string, unknown>>('ai:forge-plan')[1]).toEqual({
        orgId: 'org-src',
        soql: edited,
      });
      replyTo('ai:forge-plan', { ...CHECKED, soql: edited, fieldsChecked: 4 });

      expect(screen.queryByTestId('forge-ai-stale')).toBeNull();
      expect((screen.getByTestId('forge-discover-btn') as HTMLButtonElement).disabled).toBe(false);
    });

    it('says what the check found wrong, and keeps Discover off', () => {
      openAiTab();

      draftAndAnswer({
        success: false,
        soql: 'SELECT Id, Tier__c FROM Account',
        rootObject: 'Account',
        rootLabel: 'Account',
        fieldsChecked: 2,
        problems: [{ kind: 'field-missing', object: 'Account', field: 'Tier__c' }],
      });

      const problems = screen.getByTestId('forge-ai-problems');
      expect(problems.getAttribute('role')).toBe('alert');
      expect(problems.textContent).toContain(
        i18n.t('forge.ai.problem.fieldMissing', { object: 'Account', field: 'Tier__c' }),
      );
      expect((screen.getByTestId('forge-discover-btn') as HTMLButtonElement).disabled).toBe(true);
    });
  });

  it('asks for a record id, a query or a template, not a prompt', () => {
    render(<ForgeInput />);
    selectOrg('forge-target-org', 'org-tgt');

    const hint = screen.getByTestId('forge-discover-hint').textContent ?? '';
    expect(hint).not.toMatch(/prompt/i);
    expect(hint).toMatch(/template/i);
  });

  it('names the SOQL query field, whose placeholder was all a screen reader had', () => {
    render(<ForgeInput />);
    fireEvent.mouseDown(screen.getByTestId('forge-tab-soql'));

    expect(screen.getByRole('textbox', { name: 'SOQL query' })).toBe(
      screen.getByTestId('forge-input-soql'),
    );
  });

  it('sends the WHERE clause of a SOQL query as the filter of the object after FROM', () => {
    render(<ForgeInput />);
    fireEvent.mouseDown(screen.getByTestId('forge-tab-soql'));
    fireEvent.change(screen.getByTestId('forge-input-soql'), {
      target: { value: "SELECT Id, Name FROM Account WHERE Industry = 'X' ORDER BY Name" },
    });
    selectOrg('forge-target-org', 'org-tgt');
    fireEvent.click(screen.getByTestId('forge-discover-btn'));

    expect(mockSetConfig).toHaveBeenCalledTimes(1);
    const config = mockSetConfig.mock.calls[0][0];
    expect(config.inputMode).toBe('soql');
    expect(config.objectSoqlFilters).toEqual({ Account: "Industry = 'X'" });
    // Related objects are still read from their whole tables: the cap stays.
    expect(config.maxRecordsPerObject).toBeLessThanOrEqual(200);
  });

  it('sends no filter for a SOQL query without a WHERE clause', () => {
    render(<ForgeInput />);
    fireEvent.mouseDown(screen.getByTestId('forge-tab-soql'));
    fireEvent.change(screen.getByTestId('forge-input-soql'), {
      target: { value: 'SELECT Id FROM Account' },
    });
    selectOrg('forge-target-org', 'org-tgt');
    fireEvent.click(screen.getByTestId('forge-discover-btn'));

    expect(mockSetConfig.mock.calls[0][0].objectSoqlFilters).toBeUndefined();
    expect(screen.queryByTestId('forge-soql-where-warning')).toBeNull();
  });

  it.each([
    ['longer than 512 characters', `Name = '${'x'.repeat(510)}'`],
    ['containing a comment marker, even quoted', "Name LIKE '%--%'"],
  ])('refuses to discover with a WHERE clause %s, and says why', (_label, where) => {
    render(<ForgeInput />);
    fireEvent.mouseDown(screen.getByTestId('forge-tab-soql'));
    fireEvent.change(screen.getByTestId('forge-input-soql'), {
      target: { value: `SELECT Id FROM Account WHERE ${where}` },
    });
    selectOrg('forge-target-org', 'org-tgt');

    const refusal = screen.getByTestId('forge-soql-filter-refused').textContent ?? '';
    expect(refusal).toContain('512');
    expect(refusal).toContain('--');
    expect(screen.queryByTestId('forge-soql-where-warning')).toBeNull();
    expect((screen.getByTestId('forge-discover-btn') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('forge-discover-hint').textContent).toMatch(/WHERE/);
    fireEvent.click(screen.getByTestId('forge-discover-btn'));
    expect(mockSetConfig).not.toHaveBeenCalled();
  });

  it('names the FROM clause, not the WHERE one, when an alias leads nowhere', () => {
    // `x` is declared by nothing, so `a.Name` cannot be rewritten and the run
    // is held back. The WHERE clause itself breaks none of the filter rules:
    // telling the user to shorten it names the wrong clause.
    render(<ForgeInput />);
    fireEvent.mouseDown(screen.getByTestId('forge-tab-soql'));
    fireEvent.change(screen.getByTestId('forge-input-soql'), {
      target: { value: "SELECT Id FROM Contact c, x.Account a WHERE a.Name = 'X'" },
    });
    selectOrg('forge-target-org', 'org-tgt');

    expect(screen.getByTestId('forge-soql-filter-refused').textContent).toBe(
      i18n.t('forge.soqlAliasRefused'),
    );
    expect((screen.getByTestId('forge-discover-btn') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('forge-discover-hint').textContent).toBe(
      i18n.t('forge.hintSoqlAliasRefused'),
    );
  });

  it('says the WHERE clause filters only the object after FROM', () => {
    render(<ForgeInput />);
    fireEvent.mouseDown(screen.getByTestId('forge-tab-soql'));
    fireEvent.change(screen.getByTestId('forge-input-soql'), {
      target: { value: "SELECT Id FROM Account WHERE Industry = 'X'" },
    });

    const warning = screen.getByTestId('forge-soql-where-warning').textContent ?? '';
    expect(warning).not.toMatch(/not applied/i);
    expect(warning).toContain('Account');
    expect(warning).toContain('200');
  });

  it('refuses to discover when the name after FROM is not an API name', () => {
    // The clause is fine; the name it would travel under is not, and Discover
    // was refused by the extension with nothing shown under the query.
    render(<ForgeInput />);
    fireEvent.mouseDown(screen.getByTestId('forge-tab-soql'));
    fireEvent.change(screen.getByTestId('forge-input-soql'), {
      target: { value: 'SELECT Id FROM 1Account WHERE Name = null' },
    });
    selectOrg('forge-target-org', 'org-tgt');

    expect(screen.getByTestId('forge-soql-object-invalid').textContent).toContain('1Account');
    expect(screen.queryByTestId('forge-soql-filter-refused')).toBeNull();
    expect(screen.queryByTestId('forge-soql-where-warning')).toBeNull();
    expect((screen.getByTestId('forge-discover-btn') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('forge-discover-btn'));
    expect(mockSetConfig).not.toHaveBeenCalled();
  });

  it('should have record tab active by default', () => {
    render(<ForgeInput />);
    const recordTab = screen.getByTestId('forge-tab-record');
    expect(recordTab.getAttribute('data-state')).toBe('active');
  });

  it('should render the record input field', () => {
    render(<ForgeInput />);
    expect(screen.getByTestId('forge-input-record')).toBeDefined();
  });

  it('should allow typing in record ID field', () => {
    render(<ForgeInput />);
    const input = screen.getByTestId('forge-input-record') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '001XXXXXXXXXXXXXXX' } });
    expect(input.value).toBe('001XXXXXXXXXXXXXXX');
  });

  it('should have SOQL tab as a clickable trigger', () => {
    render(<ForgeInput />);
    const soqlTab = screen.getByTestId('forge-tab-soql');
    // Verify it exists and has the correct role for accessibility
    expect(soqlTab.getAttribute('role')).toBe('tab');
    // Initially the record tab is active and SOQL is inactive
    expect(soqlTab.getAttribute('data-state')).toBe('inactive');
    expect(screen.getByTestId('forge-tab-record').getAttribute('data-state')).toBe('active');
  });

  it('should render depth selectors', () => {
    render(<ForgeInput />);
    expect(screen.getByTestId('forge-depth-direct')).toBeDefined();
    expect(screen.getByTestId('forge-depth-full')).toBeDefined();
    expect(screen.getByTestId('forge-depth-custom')).toBeDefined();
  });

  it('should render source and target org selectors', () => {
    render(<ForgeInput />);
    expect(screen.getByTestId('forge-source-org')).toBeDefined();
    expect(screen.getByTestId('forge-target-org')).toBeDefined();
  });

  it('should render option toggles', () => {
    render(<ForgeInput />);
    expect(screen.getByTestId('forge-anonymize-toggle')).toBeDefined();
    expect(screen.getByTestId('forge-skip-empty-toggle')).toBeDefined();
  });

  it('should expand a user template into its saved record input when discovering', () => {
    // The extension cannot resolve a bare templateId (templates live in the
    // webview store) — handleDiscover must expand the template's saved root
    // input into the outgoing config.
    mockTemplates.list.push({
      id: 'tpl-rec',
      name: 'Account pack',
      description: '',
      config: { inputMode: 'record', recordId: '001XXXXXXXXXXXXXXX', depth: 'full' },
      objectCount: 0,
      recordCount: 0,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    });
    render(<ForgeInput />);

    // Radix tabs activate on mouseDown (automatic mode), not click.
    fireEvent.mouseDown(screen.getByTestId('forge-tab-template'));
    fireEvent.click(screen.getByText('Account pack'));
    selectOrg('forge-target-org', 'org-tgt');
    fireEvent.click(screen.getByTestId('forge-discover-btn'));

    expect(mockSetConfig).toHaveBeenCalledTimes(1);
    const config = mockSetConfig.mock.calls[0][0];
    expect(config.inputMode).toBe('record');
    expect(config.recordId).toBe('001XXXXXXXXXXXXXXX');
    expect(config.templateId).toBeUndefined();
    expect(mockSetPhase).toHaveBeenCalledWith('discovery');
  });

  /**
   * A SOQL template runs its saved query exactly as the SOQL tab would, so the
   * picker has to carry the same two verdicts. It used to show neither: the
   * warnings were derived from the typed query alone, which is empty here.
   */
  describe('a selected SOQL template carries the verdicts of its query', () => {
    function pickTemplate(soqlQuery: string): void {
      mockTemplates.list.push({
        id: 'tpl-soql',
        name: 'Filtered accounts',
        description: '',
        config: { inputMode: 'soql', soqlQuery, depth: 'full' },
        objectCount: 0,
        recordCount: 0,
        createdAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString(),
      });
      render(<ForgeInput />);
      fireEvent.mouseDown(screen.getByTestId('forge-tab-template'));
      fireEvent.click(screen.getByText('Filtered accounts'));
    }

    it('warns which object a valid WHERE clause narrows', () => {
      pickTemplate("SELECT Id FROM Account WHERE Industry = 'X'");

      const warning = screen.getByTestId('forge-soql-where-warning').textContent ?? '';
      expect(warning).toContain('Account');
      expect(screen.queryByTestId('forge-soql-filter-refused')).toBeNull();
    });

    it('refuses a clause the run would reject, and shows no warning beside it', () => {
      pickTemplate("SELECT Id FROM Account WHERE Name LIKE '%--%'");

      expect(screen.getByTestId('forge-soql-filter-refused')).toBeDefined();
      expect(screen.queryByTestId('forge-soql-where-warning')).toBeNull();
    });

    it('names the FROM clause when a saved query declares an alias that leads nowhere', () => {
      pickTemplate("SELECT Id FROM Contact c, x.Account a WHERE a.Name = 'X'");
      selectOrg('forge-target-org', 'org-tgt');

      expect(screen.getByTestId('forge-soql-filter-refused').textContent).toBe(
        i18n.t('forge.soqlAliasRefused'),
      );
      expect(screen.getByTestId('forge-discover-hint').textContent).toBe(
        i18n.t('forge.hintSoqlAliasRefused'),
      );
    });

    it('refuses a template whose query names no API name after FROM', () => {
      pickTemplate('SELECT Id FROM 1Account WHERE Name = null');
      selectOrg('forge-target-org', 'org-tgt');

      expect(screen.getByTestId('forge-soql-object-invalid').textContent).toContain('1Account');
      expect(screen.queryByTestId('forge-soql-where-warning')).toBeNull();
      expect((screen.getByTestId('forge-discover-btn') as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByTestId('forge-discover-hint').textContent).toBe(
        i18n.t('forge.hintSoqlObjectNameInvalid'),
      );
    });

    it('says nothing about a template that saved a record id', () => {
      mockTemplates.list.push({
        id: 'tpl-rec-2',
        name: 'One account',
        description: '',
        config: { inputMode: 'record', recordId: '001XXXXXXXXXXXXXXX', depth: 'full' },
        objectCount: 0,
        recordCount: 0,
        createdAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString(),
      });
      render(<ForgeInput />);
      fireEvent.mouseDown(screen.getByTestId('forge-tab-template'));
      fireEvent.click(screen.getByText('One account'));

      expect(screen.queryByTestId('forge-soql-where-warning')).toBeNull();
      expect(screen.queryByTestId('forge-soql-filter-refused')).toBeNull();
    });
  });

  it('should disable discover button when no input is provided', () => {
    render(<ForgeInput />);
    const btn = screen.getByTestId('forge-discover-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('should call setConfig and setPhase when discover is clicked with valid input', () => {
    render(<ForgeInput />);

    // Fill in record ID
    const recordInput = screen.getByTestId('forge-input-record') as HTMLInputElement;
    fireEvent.change(recordInput, { target: { value: '001XXXXXXXXXXXXXXX' } });

    // Source org is auto-selected from selectedOrgId; just set target
    selectOrg('forge-target-org', 'org-tgt');

    // Click discover
    const btn = screen.getByTestId('forge-discover-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);

    expect(mockSetConfig).toHaveBeenCalledTimes(1);
    expect(mockSetPhase).toHaveBeenCalledWith('discovery');

    const config = mockSetConfig.mock.calls[0][0];
    expect(config.inputMode).toBe('record');
    expect(config.recordId).toBe('001XXXXXXXXXXXXXXX');
    expect(config.sourceOrgId).toBe('org-src');
    expect(config.targetOrgId).toBe('org-tgt');
  });

  it('should extract record ID from a full Salesforce URL when discovering', () => {
    render(<ForgeInput />);

    const recordInput = screen.getByTestId('forge-input-record') as HTMLInputElement;
    fireEvent.change(recordInput, {
      target: {
        value: 'https://myorg.lightning.force.com/lightning/r/Account/001XXXXXXXXXXXXXXX/view',
      },
    });

    // Source is auto-selected; set target
    selectOrg('forge-target-org', 'org-tgt');

    fireEvent.click(screen.getByTestId('forge-discover-btn'));

    expect(mockSetConfig).toHaveBeenCalledTimes(1);
    const config = mockSetConfig.mock.calls[0][0];
    expect(config.recordId).toBe('001XXXXXXXXXXXXXXX');
  });

  it('should show em-dash for estimated objects when no preview is loaded', () => {
    render(<ForgeInput />);
    const estObjects = screen.getByTestId('est-objects');
    expect(estObjects.textContent).toBe('\u2014');
  });

  it('should show preview-derived data when preview is loaded', async () => {
    render(<ForgeInput />);

    // Simulate preview response
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            id: 'test-preview-1',
            type: 'forge:preview:response',
            timestamp: Date.now(),
            payload: {
              objectApiName: 'Account',
              objectLabel: 'Account',
              recordId: '001XXXXXXXXXXXXXXX',
              fields: [
                { name: 'Name', value: 'Test' },
                { name: 'Industry', value: 'Tech' },
                { name: 'Phone', value: '555-1234' },
              ],
            },
          },
        }),
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('est-objects').textContent).toBe('1');
      expect(screen.getByTestId('est-fields').textContent).toBe('3');
    });
  });

  it('should pass plain 18-char ID as-is when discovering', () => {
    render(<ForgeInput />);

    const recordInput = screen.getByTestId('forge-input-record') as HTMLInputElement;
    fireEvent.change(recordInput, { target: { value: '003ABCDEFGHIJKLMNO' } });

    // Source is auto-selected; set target
    selectOrg('forge-target-org', 'org-tgt');

    fireEvent.click(screen.getByTestId('forge-discover-btn'));

    expect(mockSetConfig).toHaveBeenCalledTimes(1);
    const config = mockSetConfig.mock.calls[0][0];
    expect(config.recordId).toBe('003ABCDEFGHIJKLMNO');
  });

  /* ---- Auto-select source org on mount ---- */
  it('should auto-select source org from global selectedOrgId on mount', () => {
    render(<ForgeInput />);
    const sourceTrigger = screen.getByTestId('forge-source-org');
    // OrgDropdown shows the alias of the auto-selected org
    expect(sourceTrigger.textContent).toContain('SourceOrg');
  });

  /* ---- Same org guard ---- */
  it('should show warning and disable discover when source === target', () => {
    render(<ForgeInput />);
    // Source is auto-selected to org-src; set target to the same
    selectOrg('forge-target-org', 'org-src');
    // Fill input to isolate the guard
    const input = screen.getByTestId('forge-input-record') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '001XXXXXXXXXXXXXXX' } });
    expect(screen.getByTestId('forge-same-org-warning')).toBeDefined();
    expect((screen.getByTestId('forge-discover-btn') as HTMLButtonElement).disabled).toBe(true);
  });

  /* ---- Swap orgs ---- */
  it('should swap source and target orgs when swap button is clicked', () => {
    render(<ForgeInput />);
    // Source is auto-selected to org-src; set target to org-tgt
    selectOrg('forge-target-org', 'org-tgt');
    fireEvent.click(screen.getByTestId('forge-swap-orgs'));
    // After swap: source should show TargetOrg, target should show SourceOrg
    const sourceTrigger = screen.getByTestId('forge-source-org');
    const targetTrigger = screen.getByTestId('forge-target-org');
    expect(sourceTrigger.textContent).toContain('TargetOrg');
    expect(targetTrigger.textContent).toContain('SourceOrg');
  });

  /* ---- Disabled CTA hint ---- */
  it('should show hint message when discover button is disabled', () => {
    render(<ForgeInput />);
    // Clear source org that was auto-selected by selecting the empty option
    selectOrg('forge-source-org', 'empty');
    expect(screen.getByTestId('forge-discover-hint')).toBeDefined();
  });

  /* ---- Depth chip tooltips ---- */
  it('should render depth chips with title tooltips', () => {
    render(<ForgeInput />);
    const directChip = screen.getByTestId('forge-depth-direct');
    expect(directChip.getAttribute('title')).toBeTruthy();
    const fullChip = screen.getByTestId('forge-depth-full');
    expect(fullChip.getAttribute('title')).toBeTruthy();
  });

  /* ---- Ctrl+Enter submit (SOQL textarea: plain Enter is a newline there) ---- */
  it('should launch discovery on Ctrl+Enter from the SOQL editor', () => {
    render(<ForgeInput />);
    fireEvent.mouseDown(screen.getByTestId('forge-tab-soql'));
    const editor = screen.getByTestId('forge-input-soql');
    fireEvent.change(editor, { target: { value: 'SELECT Id FROM Account' } });
    selectOrg('forge-target-org', 'org-tgt');

    fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true });

    expect(mockSetConfig).toHaveBeenCalledTimes(1);
    expect(mockSetConfig.mock.calls[0][0].inputMode).toBe('soql');
    expect(mockSetPhase).toHaveBeenCalledWith('discovery');
  });

  it('should launch discovery on Cmd+Enter from the SOQL editor', () => {
    // macOS sends metaKey, and the run must start there too.
    render(<ForgeInput />);
    fireEvent.mouseDown(screen.getByTestId('forge-tab-soql'));
    const editor = screen.getByTestId('forge-input-soql');
    fireEvent.change(editor, { target: { value: 'SELECT Id FROM Account' } });
    selectOrg('forge-target-org', 'org-tgt');

    fireEvent.keyDown(editor, { key: 'Enter', metaKey: true });

    expect(mockSetPhase).toHaveBeenCalledWith('discovery');
  });

  it('should leave a bare Enter in the SOQL editor alone', () => {
    // Enter writes a newline in a multi-line query; only the modifier submits.
    render(<ForgeInput />);
    fireEvent.mouseDown(screen.getByTestId('forge-tab-soql'));
    const editor = screen.getByTestId('forge-input-soql');
    fireEvent.change(editor, { target: { value: 'SELECT Id FROM Account' } });
    selectOrg('forge-target-org', 'org-tgt');

    fireEvent.keyDown(editor, { key: 'Enter' });

    expect(mockSetPhase).not.toHaveBeenCalled();
  });

  it('should not trigger discover on Ctrl+Enter when canDiscover is false', () => {
    render(<ForgeInput />);
    fireEvent.mouseDown(screen.getByTestId('forge-tab-soql'));
    const editor = screen.getByTestId('forge-input-soql');
    // A query, but no target org: there is nowhere to forge into.
    fireEvent.change(editor, { target: { value: 'SELECT Id FROM Account' } });

    fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true });

    expect(mockSetPhase).not.toHaveBeenCalled();
  });

  /* ---- Unreadable record id: caught here, not after the org round trip ---- */
  it('should flag an unreadable record id and refuse to discover with it', () => {
    render(<ForgeInput />);
    const input = screen.getByTestId('forge-input-record') as HTMLInputElement;
    // A paste that lost a chunk in the middle: extractRecordId returns null,
    // so the config would travel with recordId: undefined.
    fireEvent.change(input, { target: { value: '001XXXX XXXXXXXXXX' } });
    selectOrg('forge-target-org', 'org-tgt');

    expect(screen.getByTestId('forge-record-id-error')).toBeDefined();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect((screen.getByTestId('forge-discover-btn') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByTestId('forge-discover-btn'));
    expect(mockSetConfig).not.toHaveBeenCalled();
    expect(mockSetPhase).not.toHaveBeenCalled();
  });

  it('should not flag a record id the parser can read', () => {
    render(<ForgeInput />);
    const input = screen.getByTestId('forge-input-record') as HTMLInputElement;
    fireEvent.change(input, {
      target: {
        value: 'https://myorg.lightning.force.com/lightning/r/Account/001XXXXXXXXXXXXXXX/view',
      },
    });
    expect(screen.queryByTestId('forge-record-id-error')).toBeNull();
    // 15-char ids are legal too — the executor resolves the object from the prefix.
    fireEvent.change(input, { target: { value: '001XXXXXXXXXXXX' } });
    expect(screen.queryByTestId('forge-record-id-error')).toBeNull();
  });

  /* ---- Enter submits from the record field (SOQL/AI tabs already did) ---- */
  it('should launch discovery on Enter from the record field', () => {
    render(<ForgeInput />);
    const input = screen.getByTestId('forge-input-record') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '001XXXXXXXXXXXXXXX' } });
    selectOrg('forge-target-org', 'org-tgt');

    fireEvent.keyDown(input, { key: 'Enter' });

    expect(mockSetConfig).toHaveBeenCalledTimes(1);
    expect(mockSetConfig.mock.calls[0][0].recordId).toBe('001XXXXXXXXXXXXXXX');
    expect(mockSetPhase).toHaveBeenCalledWith('discovery');
  });

  it('should not launch discovery on Enter when the record id is unreadable', () => {
    render(<ForgeInput />);
    const input = screen.getByTestId('forge-input-record') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'not-an-id' } });
    selectOrg('forge-target-org', 'org-tgt');

    fireEvent.keyDown(input, { key: 'Enter' });

    expect(mockSetPhase).not.toHaveBeenCalled();
  });

  /* ---- Preview panel shows record-mode text by default ---- */
  it('should show record-mode preview placeholder on record tab', () => {
    render(<ForgeInput />);
    // On the record tab with a source org auto-selected, the placeholder should show recordIdPlaceholder text
    const previewArea = document.querySelector(
      '[data-testid="forge-input"] .rounded-lg.border-dashed',
    );
    expect(previewArea).toBeDefined();
    // Should NOT show SOQL/AI/Template hints when on the record tab
    expect(previewArea?.textContent).not.toContain('SOQL');
    expect(previewArea?.textContent).not.toContain('AI');
  });

  /* ---- Refresh button exists ---- */
  it('should render a refresh preview button', () => {
    render(<ForgeInput />);
    const previewBtn = screen.getByTestId('forge-preview-btn');
    expect(previewBtn.getAttribute('aria-label')).toContain('efresh');
  });

  /* ---- Saved templates ---- */
  describe('saved templates', () => {
    const WEEKLY = {
      id: 'tpl-weekly',
      name: 'Weekly accounts',
      description: 'Account 360 for the dev sandbox',
      config: {
        inputMode: 'record',
        recordId: '001XXXXXXXXXXXXXXX',
        depth: 'full',
        maxNodes: 200,
        anonymizePII: true,
        skipEmpty: true,
        expandOrphanParents: true,
        batchSize: 'auto',
        maxRecordsPerObject: 500,
      },
      targetOrgId: 'org-tgt',
      anonymization: { presetId: 'preset:gdpr-default', rules: { email: 'hash' } },
      objectCount: 6,
      recordCount: 312,
      createdAt: '2026-09-01T08:00:00.000Z',
      lastUsedAt: '2026-09-01T08:00:00.000Z',
    };

    function openTemplateTab(): void {
      render(<ForgeInput />);
      fireEvent.mouseDown(screen.getByTestId('forge-tab-template'));
    }

    it('asks the extension for the templates it keeps', () => {
      render(<ForgeInput />);

      expect(sent('forge:templates:list')).toHaveLength(1);
    });

    it('offers no form that would save a template without an input, and says where one comes from', () => {
      openTemplateTab();

      expect(screen.queryByTestId('forge-template-create')).toBeNull();
      expect(screen.getByTestId('forge-templates-empty').textContent).toBe(
        i18n.t('forge.noTemplates'),
      );
    });

    it('lists each saved template with what it clones and where it writes', () => {
      mockTemplates.list.push(WEEKLY);
      openTemplateTab();

      expect(screen.getByTestId('forge-template-summary-tpl-weekly').textContent).toBe(
        [
          i18n.t('forge.recordTab'),
          '001XXXXXXXXXXXXXXX',
          i18n.t('forge.depthFull'),
          i18n.t('forge.savedTemplate.summaryTarget', { org: 'TargetOrg' }),
        ].join(' · '),
      );
      expect(
        screen.getByTestId('forge-template-apply-tpl-weekly').getAttribute('aria-pressed'),
      ).toBe('false');
    });

    it('applies a template: its scope, toggles, anonymization and target org go in the form', () => {
      mockTemplates.list.push(WEEKLY);
      openTemplateTab();

      fireEvent.click(screen.getByTestId('forge-template-apply-tpl-weekly'));

      expect(
        screen.getByTestId('forge-template-apply-tpl-weekly').getAttribute('aria-pressed'),
      ).toBe('true');
      expect(screen.getByTestId('forge-depth-full').getAttribute('aria-checked')).toBe('true');
      expect((screen.getByTestId('forge-record-limit') as HTMLSelectElement).value).toBe('500');
      expect((screen.getByTestId('forge-max-nodes') as HTMLSelectElement).value).toBe('200');
      expect(mockSetAnonymizationRules).toHaveBeenCalledWith({ email: 'hash' });
      expect(mockSetAnonymizationPresetId).toHaveBeenCalledWith('preset:gdpr-default');
      expect(screen.getByTestId('forge-template-applied').textContent).toBe(
        `${i18n.t('forge.savedTemplate.applied', { name: 'Weekly accounts' })} ${i18n.t(
          'forge.savedTemplate.targetSet',
          { org: 'TargetOrg' },
        )}`,
      );

      // Nothing was picked by hand: the run goes where the template wrote.
      fireEvent.click(screen.getByTestId('forge-discover-btn'));
      const config = mockSetConfig.mock.calls[0][0];
      expect(config).toMatchObject({
        inputMode: 'record',
        recordId: '001XXXXXXXXXXXXXXX',
        depth: 'full',
        maxNodes: 200,
        anonymizePII: true,
        skipEmpty: true,
        expandOrphanParents: true,
        maxRecordsPerObject: 500,
        sourceOrgId: 'org-src',
        targetOrgId: 'org-tgt',
      });
    });

    it('leaves the target to pick when the org a template wrote to is not connected here', () => {
      mockTemplates.list.push({ ...WEEKLY, targetOrgId: 'org-on-another-machine' });
      openTemplateTab();

      expect(screen.getByTestId('forge-template-summary-tpl-weekly').textContent).toContain(
        i18n.t('forge.savedTemplate.summaryTarget', {
          org: i18n.t('forge.savedTemplate.targetNotConnected'),
        }),
      );
      fireEvent.click(screen.getByTestId('forge-template-apply-tpl-weekly'));

      expect(screen.getByTestId('forge-template-applied').textContent).toContain(
        i18n.t('forge.savedTemplate.targetMissing'),
      );
      expect(screen.getByTestId('forge-discover-hint').textContent).toBe(
        i18n.t('forge.hintNoTarget'),
      );
    });

    it('names the template each rename and delete button acts on', () => {
      mockTemplates.list.push(WEEKLY);
      openTemplateTab();

      expect(screen.getByTestId('forge-template-edit-tpl-weekly').getAttribute('aria-label')).toBe(
        i18n.t('forge.savedTemplate.renameLabel', { name: 'Weekly accounts' }),
      );
      expect(
        screen.getByTestId('forge-template-delete-tpl-weekly').getAttribute('aria-label'),
      ).toBe(i18n.t('forge.savedTemplate.deleteLabel', { name: 'Weekly accounts' }));
    });
  });

  /* ---- Depth chips radiogroup ---- */
  it('should have role="radiogroup" on depth chips container', () => {
    render(<ForgeInput />);
    const radiogroup = screen.getByRole('radiogroup');
    expect(radiogroup).toBeDefined();
  });

  it('should have aria-checked on depth radio chips', () => {
    render(<ForgeInput />);
    const direct = screen.getByTestId('forge-depth-direct');
    const full = screen.getByTestId('forge-depth-full');
    const custom = screen.getByTestId('forge-depth-custom');
    expect(direct.getAttribute('aria-checked')).toBe('true');
    expect(full.getAttribute('aria-checked')).toBe('false');
    expect(custom.getAttribute('aria-checked')).toBe('false');
  });

  it('should navigate depth chips with ArrowRight key', () => {
    render(<ForgeInput />);
    const direct = screen.getByTestId('forge-depth-direct');
    // Initially "direct" is selected
    expect(direct.getAttribute('aria-checked')).toBe('true');
    // Press ArrowRight on direct -> should select full
    fireEvent.keyDown(direct, { key: 'ArrowRight' });
    const full = screen.getByTestId('forge-depth-full');
    expect(full.getAttribute('aria-checked')).toBe('true');
    expect(direct.getAttribute('aria-checked')).toBe('false');
  });
});
