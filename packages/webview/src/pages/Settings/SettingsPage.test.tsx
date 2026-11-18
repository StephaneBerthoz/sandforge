import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import i18n from '../../i18n';
import { SettingsPage } from './SettingsPage';
import { useAppStore } from '../../stores/useAppStore';
import en from '../../i18n/locales/en.json';
import { dispatchLocaleResponse, stubLocaleBridge } from '../../i18n/testing/mockLocaleBridge';

/* The i18n module posts `i18n:locale` through this api for lazy locales. */
const mockPostMessage = vi.fn();
vi.mock('../../hooks/useVSCodeApi', () => ({
  getVscodeApi: () => ({
    postMessage: mockPostMessage,
    getState: () => undefined,
    setState: () => undefined,
  }),
  useVSCodeApi: () => ({
    postMessage: mockPostMessage,
    getState: () => undefined,
    setState: () => undefined,
  }),
}));

/* ------------------------------------------------------------------ */
/* Mock bridge hooks                                                   */
/* ------------------------------------------------------------------ */
const mockSettingsRefetch = vi.fn();
const mockSettingsUpdateMutate = vi.fn();
const mockSettingsUpdateReset = vi.fn();
const mockTelemetryMutate = vi.fn();
const mockTelemetryRefetch = vi.fn();

/** Mutable telemetry status state returned by the useBridgeQuery mock. */
const mockTelemetryStatus: {
  data: { enabled: boolean; eventCount: number } | null;
  error: string | null;
} = { data: null, error: null };

/** Request types issued through useBridgeQuery, in call order. */
const bridgeQueryTypes: string[] = [];

/** What `ai:status` answers, set per test. */
const mockAiStatus: {
  data: {
    enabled: boolean;
    provider: string;
    model: string;
    hasKey?: boolean;
    errorResolution?: boolean;
  } | null;
} = { data: null };

/** The mutate of each AI request, by request type. */
const mockAiMutate: Record<string, ReturnType<typeof vi.fn>> = {
  'ai:save-key': vi.fn(),
  'ai:settings': vi.fn(),
  'ai:remove-key': vi.fn(),
};

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: (type: string) => {
    bridgeQueryTypes.push(type);
    if (type === 'telemetry:status') {
      return {
        data: mockTelemetryStatus.data,
        loading: false,
        error: mockTelemetryStatus.error,
        refetch: mockTelemetryRefetch,
      };
    }
    if (type === 'ai:status') {
      return { data: mockAiStatus.data, loading: false, error: null, refetch: vi.fn() };
    }
    return {
      data: null,
      loading: false,
      error: null,
      refetch: mockSettingsRefetch,
    };
  },
}));

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: (type: string) => {
    if (type === 'telemetry:toggle') {
      return {
        mutate: mockTelemetryMutate,
        data: null,
        loading: false,
        error: null,
        reset: vi.fn(),
      };
    }
    const aiMutate = mockAiMutate[type];
    if (aiMutate) {
      return { mutate: aiMutate, data: null, loading: false, error: null, reset: vi.fn() };
    }
    return {
      mutate: mockSettingsUpdateMutate,
      data: null,
      loading: false,
      error: null,
      reset: mockSettingsUpdateReset,
    };
  },
}));

/** The payloads of every message of `type` the page posted. */
function sent(type: string): unknown[] {
  return mockPostMessage.mock.calls
    .map(([envelope]) => (envelope as { payload?: { type?: string; payload?: unknown } }).payload)
    .filter((message) => message?.type === type)
    .map((message) => message?.payload);
}

describe('SettingsPage', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
    mockSettingsUpdateMutate.mockClear();
    mockTelemetryStatus.data = null;
    mockTelemetryStatus.error = null;
    mockTelemetryMutate.mockClear();
    mockTelemetryRefetch.mockClear();
    bridgeQueryTypes.length = 0;
    mockAiStatus.data = null;
    for (const mutate of Object.values(mockAiMutate)) mutate.mockClear();
    // Auto-answer lazy locale requests with the real bundles.
    stubLocaleBridge(mockPostMessage);
  });

  // A test that changed the language and failed before it put English back
  // would leave every test after it reading French.
  afterEach(async () => {
    if (i18n.language !== 'en') await i18n.changeLanguage('en');
  });

  it('should render the page', () => {
    render(<SettingsPage />);
    expect(screen.getByTestId('settings-page')).toBeDefined();
  });

  it('should show page title', () => {
    render(<SettingsPage />);
    expect(screen.getByText('Settings')).toBeDefined();
  });

  it('lays its four sections out on one page, each under a heading, with no tab to open', () => {
    // Four tabs held some 1,300 pixels between them, each three-quarters
    // empty, and what a tab held was out of sight until it was opened.
    render(<SettingsPage />);
    expect(screen.queryAllByRole('tab')).toEqual([]);
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'General',
      'AI',
      'Share setup',
      'Diagnostics',
    ]);
    for (const [testId, heading] of [
      ['general-settings', 'General'],
      ['ai-settings', 'AI'],
      ['profiles-settings', 'Share setup'],
      ['telemetry-settings', 'Diagnostics'],
    ]) {
      const section = screen.getByTestId(testId);
      expect(section.tagName).toBe('SECTION');
      expect(screen.getByRole('region', { name: heading })).toBe(section);
    }
    expect(screen.queryByText('Advanced')).toBeNull();
    expect(screen.queryByText('Export / Import')).toBeNull();
  });

  it('should show general settings by default', () => {
    render(<SettingsPage />);
    expect(screen.getByTestId('general-settings')).toBeDefined();
  });

  it('should show language select', () => {
    render(<SettingsPage />);
    expect(screen.getByTestId('language-select')).toBeDefined();
  });

  it('opens on the AI section, its key field focused, when a caller asks for it, once', () => {
    // Every "Open AI settings" shown for want of a key landed on General, a
    // click away from the key.
    const scrolled: Element[] = [];
    Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
      scrolled.push(this);
    });
    try {
      useAppStore.getState().navigate('settings', { settingsTab: 'ai' });
      const { unmount } = render(<SettingsPage />);
      expect(scrolled).toEqual([screen.getByTestId('ai-settings')]);
      expect(document.activeElement).toBe(screen.getByTestId('ai-api-key-input'));
      expect(useAppStore.getState().navigationIntent).toBeNull();
      unmount();

      // Read once: a later visit opens at the top, and moves no focus.
      render(<SettingsPage />);
      expect(scrolled).toHaveLength(1);
      expect(document.activeElement).toBe(document.body);
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
  });

  it('keeps a language as soon as it applies, with no Save button to press', async () => {
    // The language applied on change, and was kept only once Save, a button
    // below it, was pressed; Advanced held a Reset to Defaults that put the
    // interface back in English under a Confirm that never said so.
    const onSave = vi.fn();
    render(<SettingsPage onSave={onSave} />);
    expect(screen.queryByTestId('save-settings-btn')).toBeNull();
    expect(screen.queryByTestId('reset-btn')).toBeNull();

    fireEvent.change(screen.getByTestId('language-select'), { target: { value: 'fr' } });

    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ language: 'fr' }));
    expect(mockSettingsUpdateMutate).toHaveBeenLastCalledWith({
      key: 'settings',
      value: { language: 'fr' },
    });
    fireEvent.change(screen.getByTestId('language-select'), { target: { value: 'en' } });
    await waitFor(() => expect(i18n.language).toBe('en'));
  });

  it('has no Save button in any section, beside controls that keep what they change', () => {
    render(<SettingsPage />);
    expect(screen.queryByTestId('save-settings-btn')).toBeNull();
    // AI: the key is committed by the button inside the field row, and says
    // it turns AI on as well while no key is stored.
    expect(screen.getAllByRole('button', { name: /^Save/ })).toEqual([
      screen.getByTestId('ai-save-key-btn'),
    ]);
  });

  it("opens VS Code's Settings on Production Guard, by a button that says so", () => {
    // The walkthrough named batch sizes, Production Guard and Forge's graph
    // view, then opened this page, where none of them is and nothing led
    // there; its button read More settings in VS Code, and opened on
    // Production Guard without a word.
    render(<SettingsPage />);
    expect(screen.getByTestId('vscode-settings').textContent).toContain(
      en.settings.vscodeSettingsDesc,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Production Guard and other settings' }));

    expect(sent('workbench:open-setting')).toEqual([{ setting: 'sandforge.safety' }]);
  });

  it('puts the select back and says so when a language fails to load', async () => {
    // Answer every locale request with an error, as the extension does when
    // the bundle cannot be read.
    mockPostMessage.mockImplementation((message: unknown) => {
      const request = (message as { payload?: { id?: unknown; type?: unknown } }).payload;
      if (request?.type === 'i18n:locale' && typeof request.id === 'string') {
        const id = request.id;
        setTimeout(() => dispatchLocaleResponse(id, 'unshipped'), 0);
      }
    });
    render(<SettingsPage />);
    const select = screen.getByTestId('language-select') as HTMLSelectElement;

    fireEvent.change(select, { target: { value: 'de' } });

    // The select used to keep showing Deutsch over an English UI, silently.
    await waitFor(() => expect(screen.getByTestId('language-error')).toBeDefined());
    expect(i18n.language).toBe('en');
    expect(select.value).toBe('en');
    // A language that did not apply is not kept either.
    expect(mockSettingsUpdateMutate).not.toHaveBeenCalled();
  });

  it('should not ship a plugins tab — the plugin manager never existed', () => {
    render(<SettingsPage />);
    expect(screen.queryByText('Plugins')).toBeNull();
    expect(screen.queryByTestId('plugins-settings')).toBeNull();
  });

  it('shares the saved setup in a section of its own, named for what it does', () => {
    // Its tab read Export / Import, beside an Export that exported no setting.
    render(<SettingsPage />);

    const section = screen.getByTestId('profiles-settings');
    expect(within(section).getByRole('heading', { level: 2 }).textContent).toBe(
      en.config.profiles.title,
    );
    expect(within(section).getByTestId('config-profile-panel')).toBeDefined();
    expect(screen.getByTestId('config-export-section')).toBeDefined();
    expect(screen.getByTestId('config-import-section')).toBeDefined();
    expect(bridgeQueryTypes).toContain('config:categories');
  });

  it('should show Diagnostics with its disabled status', () => {
    render(<SettingsPage />);
    expect(
      within(screen.getByTestId('telemetry-settings')).getByText(en.settings.telemetryDisabled),
    ).toBeDefined();
    expect(screen.getByTestId('telemetry-toggle-btn')).toBeDefined();
  });

  it('opens the log Diagnostics writes to, and counts no event that log does not show', () => {
    // It counted "Diagnostic events recorded", breadcrumbs among them, which
    // the log leaves out, and nothing on the page opened that log.
    mockTelemetryStatus.data = { enabled: true, eventCount: 3 };
    render(<SettingsPage />);
    const panel = screen.getByTestId('telemetry-settings');
    expect(screen.queryByTestId('telemetry-events')).toBeNull();
    expect(panel.textContent).not.toMatch(/recorded|buffer/i);

    fireEvent.click(within(panel).getByRole('button', { name: 'Open log' }));

    expect(sent('workbench:open-log')).toHaveLength(1);
  });

  it('says what Diagnostics records and that nothing leaves the machine, before its switch', () => {
    // "Telemetry", a status and an Enable button, and nothing said what was
    // recorded or where it went: read as data leaving the machine.
    render(<SettingsPage />);

    const description = screen.getByTestId('telemetry-description');
    expect(description.textContent).toBe(en.settings.telemetryDesc);
    expect(description.textContent).toMatch(/local log/);
    expect(description.textContent).toMatch(/Nothing is sent over the network/);
    expect(
      description.compareDocumentPosition(screen.getByTestId('telemetry-toggle-btn')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByTestId('telemetry-toggle-btn').textContent).toBe(
      en.settings.telemetryEnable,
    );
  });

  it('should display the telemetry status the extension reports', () => {
    mockTelemetryStatus.data = { enabled: true, eventCount: 42 };
    render(<SettingsPage />);
    expect(
      within(screen.getByTestId('telemetry-settings')).getByText(en.settings.telemetryEnabled),
    ).toBeDefined();
  });

  it('should dispatch the telemetry:toggle mutation when toggle clicked', () => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByTestId('telemetry-toggle-btn'));
    expect(mockTelemetryMutate).toHaveBeenCalledWith({ enabled: true });
  });

  it('should dispatch enabled:false when telemetry is currently on', () => {
    mockTelemetryStatus.data = { enabled: true, eventCount: 7 };
    render(<SettingsPage />);
    fireEvent.click(screen.getByTestId('telemetry-toggle-btn'));
    expect(mockTelemetryMutate).toHaveBeenCalledWith({ enabled: false });
  });

  it('should show an honest unavailable state when the extension does not answer', () => {
    mockTelemetryStatus.error = "Bridge query 'telemetry:status' timed out after 5000ms";
    render(<SettingsPage />);
    expect(screen.getByTestId('telemetry-unavailable')).toBeDefined();
    expect(
      within(screen.getByTestId('telemetry-settings')).queryByText(en.settings.telemetryDisabled),
    ).toBeNull();
    const toggleBtn = screen.getByTestId('telemetry-toggle-btn') as HTMLButtonElement;
    expect(toggleBtn.disabled).toBe(true);
  });

  describe('the AI section', () => {
    const openAiTab = (): void => {
      render(<SettingsPage />);
    };

    it('says what each feature sends, and to whom, before any key is stored', () => {
      openAiTab();

      const what = screen.getByTestId('ai-what-is-sent');
      expect(what.textContent).toContain(en.settings.aiSendsIntro);
      expect(what.textContent).toContain('Anthropic');
    });

    it('lists each feature on a line of its own, named where it lives, NL2SOQL nowhere', () => {
      // One paragraph of six lines named Forge's AI tab "NL2SOQL", a name
      // Forge never shows; the Help's AI section names the features this way.
      openAiTab();

      const lines = within(screen.getByTestId('ai-what-is-sent'))
        .getAllByRole('listitem')
        .map((item) => item.textContent);
      expect(lines).toEqual([
        en.settings.aiSendsChat,
        en.settings.aiSendsForge,
        en.settings.aiSendsPipeline,
        en.settings.aiSendsSeed,
        en.settings.aiSendsScenario,
        en.settings.aiSendsFailures,
      ]);
      expect(lines.map((line) => line?.split(':')[0])).toEqual([
        'AI Assistant',
        'Forge, AI tab',
        'Automation, pipeline drafts',
        'Seed, custom personas and AI field rules',
        'Seed, Draft from your own text',
        'Fix suggestions for failed runs',
      ]);
      expect(screen.getByTestId('ai-settings').textContent).not.toContain('NL2SOQL');
    });

    it('asks with the first key whether failed runs may be sent, and sends none unless told yes', () => {
      openAiTab();
      const box = screen.getByTestId('ai-first-key-error-resolution') as HTMLInputElement;
      expect(box.checked).toBe(false);
      fireEvent.change(screen.getByTestId('ai-api-key-input'), {
        target: { value: 'sk-ant-test' },
      });

      const save = screen.getByTestId('ai-save-key-btn');
      expect(save.textContent).toBe(en.settings.aiSaveAndTurnOn);
      fireEvent.click(save);
      expect(mockAiMutate['ai:save-key']).toHaveBeenLastCalledWith({
        apiKey: 'sk-ant-test',
        errorResolution: false,
      });

      fireEvent.click(box);
      fireEvent.click(save);
      expect(mockAiMutate['ai:save-key']).toHaveBeenLastCalledWith({
        apiKey: 'sk-ant-test',
        errorResolution: true,
      });
    });

    it('turns the fix suggestions off, and AI off, from the card', () => {
      mockAiStatus.data = {
        enabled: true,
        provider: 'anthropic',
        model: 'claude',
        hasKey: true,
        errorResolution: true,
      };
      openAiTab();
      expect(screen.queryByTestId('ai-first-key-error-resolution')).toBeNull();

      const toggle = screen.getByTestId('ai-error-resolution-toggle') as HTMLInputElement;
      expect(toggle.checked).toBe(true);
      fireEvent.click(toggle);
      expect(mockAiMutate['ai:settings']).toHaveBeenLastCalledWith({ errorResolution: false });

      const onOff = screen.getByTestId('ai-toggle-btn');
      expect(onOff.textContent).toBe(en.settings.aiTurnOff);
      fireEvent.click(onOff);
      expect(mockAiMutate['ai:settings']).toHaveBeenLastCalledWith({ enabled: false });
    });

    it('turns AI back on with the key it holds', () => {
      mockAiStatus.data = { enabled: false, provider: 'none', model: '', hasKey: true };
      openAiTab();

      const onOff = screen.getByTestId('ai-toggle-btn');
      expect(onOff.textContent).toBe(en.settings.aiTurnOn);
      fireEvent.click(onOff);
      expect(mockAiMutate['ai:settings']).toHaveBeenLastCalledWith({ enabled: true });
    });

    it('removes the key only once asked, saying the conversations go with it', () => {
      mockAiStatus.data = { enabled: true, provider: 'anthropic', model: 'claude', hasKey: true };
      openAiTab();

      fireEvent.click(screen.getByTestId('ai-remove-key-btn'));
      expect(mockAiMutate['ai:remove-key']).not.toHaveBeenCalled();
      expect(screen.getByTestId('ai-remove-key-question').textContent).toBe(
        en.settings.aiRemoveKeyConfirm,
      );
      // The answer to it names what it does, and the focus is on Cancel.
      expect(screen.getByTestId('ai-remove-key-confirm-btn').textContent).toBe(
        en.settings.aiRemoveKey,
      );
      expect(document.activeElement).toBe(screen.getByTestId('ai-remove-key-cancel-btn'));
      fireEvent.click(screen.getByTestId('ai-remove-key-cancel-btn'));
      expect(screen.queryByTestId('ai-remove-key-question')).toBeNull();
      expect(document.activeElement).toBe(screen.getByTestId('ai-remove-key-btn'));

      fireEvent.click(screen.getByTestId('ai-remove-key-btn'));
      fireEvent.click(screen.getByTestId('ai-remove-key-confirm-btn'));
      expect(mockAiMutate['ai:remove-key']).toHaveBeenCalledTimes(1);
    });

    it('asks the removal above its buttons, apart from Turn AI off', () => {
      // The question printed under its Confirm and Cancel, and the red
      // Confirm sat right beside Turn AI off.
      mockAiStatus.data = { enabled: true, provider: 'anthropic', model: 'claude', hasKey: true };
      openAiTab();
      fireEvent.click(screen.getByTestId('ai-remove-key-btn'));

      const question = screen.getByTestId('ai-remove-key-question');
      for (const id of ['ai-remove-key-confirm-btn', 'ai-remove-key-cancel-btn']) {
        expect(
          question.compareDocumentPosition(screen.getByTestId(id)) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
      }
      const removal = screen.getByTestId('ai-key-removal');
      expect(removal.contains(screen.getByTestId('ai-remove-key-confirm-btn'))).toBe(true);
      expect(removal.contains(screen.getByTestId('ai-toggle-btn'))).toBe(false);
      expect(removal.className).toContain('border-t');
    });
  });
});
