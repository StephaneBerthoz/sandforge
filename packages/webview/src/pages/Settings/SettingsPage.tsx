import React, { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../stores/useAppStore';
import { Tabs } from '../../components/ui/Tabs';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Select } from '../../components/ui/Select';
import { Input } from '../../components/ui/Input';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { sendBridgeMessage } from '../../bridge/sendBridgeMessage';
import type { SupportedLanguage } from '../../i18n';
import { changeLanguageLazy } from '../../i18n';
import { ConfigProfilePanel } from './ConfigProfilePanel';
import { useSettingsPageData } from './useSettingsPageData';

/**
 * Settings values exposed by this page.
 *
 * Only settings that are actually consumed somewhere are kept here:
 * `language` is applied immediately via `changeLanguageLazy` (which fetches
 * the locale bundle over the bridge when it is not loaded yet). The other
 * historical fields (theme, batch sizes, thresholds, notification toggles,
 * log level...) were persisted through `settings:update` but read back by
 * nothing — they were removed from the UI rather than pretending to work.
 * The effective module settings live in the VSCode manifest
 * (`sandforge.seed.defaultBatchSize`, `sandforge.sync.maxConcurrentOps`, ...).
 */
export interface SettingsValues {
  language: SupportedLanguage;
}

/** Default settings. */
export const defaultSettings: SettingsValues = {
  language: 'en',
};

/**
 * Language options with NATIVE labels: a language selector must stay
 * readable even when the UI is currently rendered in a language the user
 * cannot read, so labels are intentionally NOT translated.
 */
const LANGUAGE_OPTIONS: ReadonlyArray<{ value: SupportedLanguage; label: string }> = [
  { value: 'en', label: 'English' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' },
  { value: 'es', label: 'Español' },
  { value: 'ja', label: '日本語' },
  { value: 'pt-BR', label: 'Português (Brasil)' },
];

/**
 * What each AI feature sends, one line each, named where it lives in the
 * panel, as the Help's AI section names them. One paragraph of six lines
 * named one of them NL2SOQL, a name Forge never shows.
 */
const AI_SENDS = [
  'settings.aiSendsChat',
  'settings.aiSendsForge',
  'settings.aiSendsPipeline',
  'settings.aiSendsSeed',
  'settings.aiSendsScenario',
  'settings.aiSendsFailures',
] as const;

/**
 * The SandForge settings VS Code's Settings editor opens on: Production
 * Guard's. The host opens only a `sandforge.*` id, which the editor takes as
 * its search; the others are one search for "sandforge" away.
 */
const VSCODE_SETTINGS_GROUP = 'sandforge.safety';

/** SettingsPage component props. */
export interface SettingsPageProps {
  settings?: SettingsValues;
  onSave?: (settings: SettingsValues) => void;
}

/** Settings page with tabbed configuration panels. */
export const SettingsPage: React.FC<SettingsPageProps> = ({
  settings: initialSettings,
  onSave,
}) => {
  const { t, i18n } = useTranslation();
  const navigationIntent = useAppStore((s) => s.navigationIntent);
  const clearNavigationIntent = useAppStore((s) => s.clearNavigationIntent);
  // The tour's "Open AI settings", and every "Go to Settings" shown because
  // no key is set (the AI page, Forge's AI tab, Seed's scenario draft),
  // opened General, a click away from the key.
  const [askedTab] = useState(() =>
    navigationIntent?.route === 'settings' ? navigationIntent.settingsTab : undefined,
  );
  const [activeTab, setActiveTab] = useState<string>(askedTab ?? 'general');
  /** The key field, which takes the focus when the page is opened for it. */
  const apiKeyInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!askedTab) return;
    clearNavigationIntent();
    apiKeyInput.current?.focus();
  }, [askedTab, clearNavigationIntent]);
  /** Why the last language change did not apply, until the next change. */
  const [languageError, setLanguageError] = useState<string | null>(null);
  /**
   * Whether a failed run may send its error message, asked with the first key:
   * off until the box is ticked.
   */
  const [resolveFailures, setResolveFailures] = useState(false);
  /** Removing the key deletes the conversations too, so it asks first. */
  const [confirmingKeyRemoval, setConfirmingKeyRemoval] = useState(false);
  const keyRemovalId = useId();

  /**
   * The removal's Cancel takes the focus from the button the question
   * replaces, and gives it back to that button once the question is cancelled.
   */
  const cancelKeyRemovalRef = useRef<HTMLButtonElement>(null);
  const removeKeyRef = useRef<HTMLButtonElement>(null);
  const keyRemovalCancelled = useRef(false);
  useEffect(() => {
    if (confirmingKeyRemoval) {
      cancelKeyRemovalRef.current?.focus();
    } else if (keyRemovalCancelled.current) {
      keyRemovalCancelled.current = false;
      removeKeyRef.current?.focus();
    }
  }, [confirmingKeyRemoval]);

  const {
    settings,
    updateSetting,
    handleSave,
    aiStatus,
    aiApiKey,
    setAiApiKey,
    aiKeySaved,
    setAiKeySaved,
    saveAiKey,
    aiKeySaving,
    aiKeyError,
    updateAiSettings,
    aiSettingsSaving,
    aiSettingsError,
    removeAiKey,
    aiKeyRemoving,
    aiKeyRemoved,
    aiKeyRemoveError,
    telemetryStatus,
    telemetryStatusLoading,
    telemetryUnavailable,
    toggleTelemetry,
    telemetryToggling,
    telemetryToggleError,
  } = useSettingsPageData(initialSettings, onSave);

  const telemetryEnabled = telemetryStatus?.enabled ?? false;
  /**
   * Whether a key is stored. An older host does not say: a working assistant
   * has one.
   */
  const hasKey = aiStatus?.hasKey ?? aiStatus?.enabled === true;

  /**
   * Apply a language for real, and keep it. When its bundle cannot be loaded
   * the UI keeps its current language, so the select is put back to that
   * language and the failure is shown: left alone, the select named a language
   * the page was not rendering, and nothing said why.
   *
   * Kept as it applies: a Save button beside a language already applied kept
   * it only once pressed, and nothing said a change was waiting for it.
   */
  const applyLanguage = async (language: SupportedLanguage): Promise<void> => {
    setLanguageError(null);
    if (await changeLanguageLazy(language)) {
      handleSave();
      return;
    }
    updateSetting('language', i18n.language as SupportedLanguage);
    const label = LANGUAGE_OPTIONS.find((o) => o.value === language)?.label ?? language;
    setLanguageError(t('settings.languageLoadFailed', { language: label }));
  };

  // No Advanced tab: its one button, "Reset to Defaults", put the interface
  // back in English — language is the page's only setting — under a Confirm
  // that never said so.
  const tabs = [
    { id: 'general', label: t('settings.general') },
    { id: 'ai', label: t('settings.ai') },
    { id: 'profiles', label: t('settings.profiles') },
    { id: 'telemetry', label: t('settings.telemetry') },
  ];

  return (
    <div data-testid="settings-page" className="flex flex-col gap-3 p-4">
      <h1 tabIndex={-1} className="text-lg font-bold text-text-primary">
        {t('settings.title')}
      </h1>

      <Tabs tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab} />

      <div className="mt-2">
        {activeTab === 'general' && (
          <div
            data-testid="general-settings"
            id="tabpanel-general"
            role="tabpanel"
            aria-labelledby="tab-general"
            className="flex flex-col gap-3"
          >
            <Card>
              <CardHeader title={t('settings.general')} />
              <CardBody>
                <div className="flex flex-col gap-3">
                  {/* Language — Select renders and binds its own caption. */}
                  <Select
                    data-testid="language-select"
                    label={t('settings.language')}
                    options={LANGUAGE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                    value={settings.language}
                    onChange={(e) => {
                      const language = e.target.value as SupportedLanguage;
                      updateSetting('language', language);
                      // Apply immediately — loads the locale bundle over
                      // the bridge when needed; the i18n module persists
                      // the choice to the webview state on every change.
                      void applyLanguage(language);
                    }}
                  />
                  {languageError && (
                    <ErrorBanner
                      data-testid="language-error"
                      message={languageError}
                      onDismiss={() => setLanguageError(null)}
                    />
                  )}
                  {/* The walkthrough's "Tune your settings" names batch sizes,
                      Production Guard and Forge's graph view, then opened this
                      page, where none of them is and nothing led to them. */}
                  <div
                    className="flex flex-col items-start gap-2 border-t border-subtle pt-3"
                    data-testid="vscode-settings"
                  >
                    <p className="text-xs text-text-secondary">
                      {t('settings.vscodeSettingsDesc')}
                    </p>
                    <Button
                      data-testid="open-vscode-settings"
                      variant="secondary"
                      size="sm"
                      onClick={() =>
                        sendBridgeMessage<{ setting: string }>('workbench:open-setting', {
                          setting: VSCODE_SETTINGS_GROUP,
                        })
                      }
                    >
                      {t('settings.vscodeSettingsOpen')}
                    </Button>
                  </div>
                </div>
              </CardBody>
            </Card>
          </div>
        )}

        {activeTab === 'ai' && (
          <div
            data-testid="ai-settings"
            id="tabpanel-ai"
            role="tabpanel"
            aria-labelledby="tab-ai"
            className="flex flex-col gap-3"
          >
            <Card>
              <CardHeader title={t('settings.ai')} />
              <CardBody>
                <div className="flex flex-col gap-3">
                  {/* Status */}
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-text-primary">{t('settings.aiStatus')}</span>
                    <Badge variant={aiStatus?.enabled ? 'success' : 'default'}>
                      {aiStatus?.enabled ? t('settings.aiEnabled') : t('settings.aiDisabled')}
                    </Badge>
                  </div>

                  {aiStatus?.enabled && (
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-text-secondary">{t('settings.aiModel')}</span>
                      <span className="text-xs text-text-primary font-mono">{aiStatus!.model}</span>
                    </div>
                  )}

                  {/* What each feature sends, and to whom, said where the key is
                      stored: the card said only where the key is kept. */}
                  <div className="flex flex-col gap-1" data-testid="ai-what-is-sent">
                    <p className="text-xs text-text-secondary">{t('settings.aiSendsIntro')}</p>
                    <ul className="flex list-disc flex-col gap-1 pl-4 text-xs text-text-secondary">
                      {AI_SENDS.map((key) => (
                        <li key={key}>{t(key)}</li>
                      ))}
                    </ul>
                  </div>

                  {/* The failures are sent with nobody pressing anything: a switch
                      of their own, beside the others, while AI is on. */}
                  {aiStatus?.enabled && (
                    <label className="flex items-start gap-2 text-xs text-text-primary">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={aiStatus.errorResolution ?? true}
                        disabled={aiSettingsSaving}
                        onChange={(e) => updateAiSettings({ errorResolution: e.target.checked })}
                        data-testid="ai-error-resolution-toggle"
                      />
                      <span>{t('settings.aiErrorResolution')}</span>
                    </label>
                  )}

                  {/* API Key — Input renders and binds its own caption, so the
                      Save button aligns on the bottom edge of the field. */}
                  <div className="flex flex-col gap-1">
                    <div className="flex gap-2 items-end">
                      <div className="flex-1">
                        <Input
                          ref={apiKeyInput}
                          data-testid="ai-api-key-input"
                          label={t('settings.aiApiKey')}
                          type="password"
                          placeholder={hasKey ? t('settings.aiKeyConfigured') : 'sk-ant-...'}
                          value={aiApiKey}
                          onChange={(e) => {
                            setAiApiKey(e.target.value);
                            setAiKeySaved(false);
                          }}
                        />
                      </div>
                      <Button
                        data-testid="ai-save-key-btn"
                        variant="primary"
                        size="sm"
                        disabled={!aiApiKey.trim()}
                        loading={aiKeySaving}
                        onClick={() =>
                          saveAiKey(aiApiKey.trim(), hasKey ? undefined : resolveFailures)
                        }
                      >
                        {hasKey ? t('common.save') : t('settings.aiSaveAndTurnOn')}
                      </Button>
                    </div>
                    {/* Asked once, with the first key: saving it turned the
                        sending of failures on with AI, and nothing said so. */}
                    {!hasKey && (
                      <label className="flex items-start gap-2 text-xs text-text-primary">
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={resolveFailures}
                          onChange={(e) => setResolveFailures(e.target.checked)}
                          data-testid="ai-first-key-error-resolution"
                        />
                        <span>{t('settings.aiErrorResolution')}</span>
                      </label>
                    )}
                    {aiKeySaved && (
                      <span className="text-xs text-status-success" data-testid="ai-key-saved">
                        {t('settings.aiKeySaved')}
                      </span>
                    )}
                    {aiKeyError && <span className="text-xs text-status-error">{aiKeyError}</span>}
                  </div>

                  {/* Turning AI off, and taking the key back, were only in the
                      settings editor, and nothing removed the key at all. The
                      removal's question came under its buttons, its red Confirm
                      right beside Turn AI off: the two are apart now, the
                      question above the answer to it. */}
                  {hasKey && (
                    <div className="flex flex-col gap-3" data-testid="ai-key-actions">
                      <div>
                        <Button
                          data-testid="ai-toggle-btn"
                          variant="secondary"
                          size="sm"
                          loading={aiSettingsSaving}
                          disabled={aiKeyRemoving}
                          onClick={() => updateAiSettings({ enabled: !aiStatus?.enabled })}
                        >
                          {aiStatus?.enabled ? t('settings.aiTurnOff') : t('settings.aiTurnOn')}
                        </Button>
                      </div>
                      <div
                        className="flex flex-col items-start gap-2 border-t border-subtle pt-3"
                        data-testid="ai-key-removal"
                      >
                        {confirmingKeyRemoval ? (
                          <>
                            <p
                              id={keyRemovalId}
                              className="text-xs text-text-primary"
                              data-testid="ai-remove-key-question"
                            >
                              {t('settings.aiRemoveKeyConfirm')}
                            </p>
                            <div className="flex flex-wrap items-center gap-2">
                              <Button
                                data-testid="ai-remove-key-confirm-btn"
                                variant="danger"
                                size="sm"
                                loading={aiKeyRemoving}
                                aria-describedby={keyRemovalId}
                                onClick={() => {
                                  setConfirmingKeyRemoval(false);
                                  removeAiKey();
                                }}
                              >
                                {t('settings.aiRemoveKey')}
                              </Button>
                              <Button
                                ref={cancelKeyRemovalRef}
                                data-testid="ai-remove-key-cancel-btn"
                                variant="secondary"
                                size="sm"
                                onClick={() => {
                                  keyRemovalCancelled.current = true;
                                  setConfirmingKeyRemoval(false);
                                }}
                              >
                                {t('common.cancel')}
                              </Button>
                            </div>
                          </>
                        ) : (
                          <Button
                            ref={removeKeyRef}
                            data-testid="ai-remove-key-btn"
                            variant="secondary"
                            size="sm"
                            disabled={aiKeyRemoving || aiSettingsSaving}
                            onClick={() => setConfirmingKeyRemoval(true)}
                          >
                            {t('settings.aiRemoveKey')}
                          </Button>
                        )}
                      </div>
                    </div>
                  )}
                  {aiKeyRemoved !== null && !hasKey && (
                    <span
                      className="text-xs text-status-success"
                      role="status"
                      data-testid="ai-key-removed"
                    >
                      {t('settings.aiKeyRemoved', { count: aiKeyRemoved })}
                    </span>
                  )}
                  {(aiSettingsError || aiKeyRemoveError) && (
                    <span className="text-xs text-status-error" data-testid="ai-settings-error">
                      {aiSettingsError ?? aiKeyRemoveError}
                    </span>
                  )}

                  <p className="text-xs text-text-secondary">{t('settings.aiHint')}</p>
                </div>
              </CardBody>
            </Card>
          </div>
        )}

        {activeTab === 'profiles' && (
          <div
            data-testid="profiles-settings"
            id="tabpanel-profiles"
            role="tabpanel"
            aria-labelledby="tab-profiles"
            className="flex flex-col gap-3"
          >
            <ConfigProfilePanel />
          </div>
        )}

        {activeTab === 'telemetry' && (
          <div
            data-testid="telemetry-settings"
            id="tabpanel-telemetry"
            role="tabpanel"
            aria-labelledby="tab-telemetry"
            className="flex flex-col gap-3"
          >
            <Card>
              <CardHeader title={t('settings.telemetry')} />
              <CardBody>
                <div className="flex flex-col gap-3">
                  {/* What is recorded and where it goes, said before the switch:
                      "Telemetry" read as data leaving the machine, and nothing
                      said it only writes extension errors to a local log. */}
                  <p className="text-xs text-text-secondary" data-testid="telemetry-description">
                    {t('settings.telemetryDesc')}
                  </p>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-text-primary">
                      {t('settings.telemetryStatus')}
                    </span>
                    {telemetryStatusLoading && !telemetryStatus ? (
                      <span className="text-xs text-text-secondary">{t('common.loading')}</span>
                    ) : telemetryUnavailable ? (
                      <span
                        className="text-xs font-medium text-text-secondary"
                        data-testid="telemetry-unavailable"
                      >
                        {t('settings.telemetryUnavailable')}
                      </span>
                    ) : (
                      <span
                        className={`text-xs font-medium ${telemetryEnabled ? 'text-status-success' : 'text-text-secondary'}`}
                      >
                        {telemetryEnabled
                          ? t('settings.telemetryEnabled')
                          : t('settings.telemetryDisabled')}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-text-primary">
                      {t('settings.telemetryEventCount')}
                    </span>
                    <span className="text-xs text-text-secondary" data-testid="telemetry-events">
                      {telemetryStatus ? telemetryStatus.eventCount : '—'}
                    </span>
                  </div>
                  {telemetryToggleError && (
                    <span className="text-xs text-status-error" data-testid="telemetry-error">
                      {telemetryToggleError}
                    </span>
                  )}
                  <Button
                    data-testid="telemetry-toggle-btn"
                    variant="secondary"
                    size="sm"
                    loading={telemetryToggling}
                    disabled={telemetryUnavailable || telemetryToggling}
                    onClick={toggleTelemetry}
                  >
                    {telemetryEnabled
                      ? t('settings.telemetryDisable')
                      : t('settings.telemetryEnable')}
                  </Button>
                </div>
              </CardBody>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
};
