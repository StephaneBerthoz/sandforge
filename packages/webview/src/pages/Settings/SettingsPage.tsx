import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Tabs } from '../../components/ui/Tabs';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Select } from '../../components/ui/Select';
import { Input } from '../../components/ui/Input';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
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

/** SettingsPage component props. */
export interface SettingsPageProps {
  settings?: SettingsValues;
  onSave?: (settings: SettingsValues) => void;
  onReset?: () => void;
  onClearCache?: () => void;
}

/** Settings page with tabbed configuration panels. */
export const SettingsPage: React.FC<SettingsPageProps> = ({
  settings: initialSettings,
  onSave,
  onReset,
  onClearCache,
}) => {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState('general');

  const {
    settings,
    updateSetting,
    handleSave,
    handleReset,
    aiStatus,
    aiApiKey,
    setAiApiKey,
    aiKeySaved,
    setAiKeySaved,
    saveAiKey,
    aiKeySaving,
    aiKeyError,
    telemetryStatus,
    telemetryStatusLoading,
    telemetryUnavailable,
    toggleTelemetry,
    telemetryToggling,
    telemetryToggleError,
  } = useSettingsPageData(initialSettings, onSave, onReset);

  const telemetryEnabled = telemetryStatus?.enabled ?? false;

  const tabs = [
    { id: 'general', label: t('settings.general') },
    { id: 'ai', label: t('settings.ai') },
    { id: 'advanced', label: t('settings.advanced') },
    { id: 'profiles', label: t('settings.profiles') },
    { id: 'telemetry', label: t('settings.telemetry') },
  ];

  return (
    <div data-testid="settings-page" className="flex flex-col gap-3 p-4">
      <h1 className="text-lg font-bold text-text-primary">{t('settings.title')}</h1>

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
                      void changeLanguageLazy(language);
                    }}
                  />
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

                  {/* API Key — Input renders and binds its own caption, so the
                      Save button aligns on the bottom edge of the field. */}
                  <div className="flex flex-col gap-1">
                    <div className="flex gap-2 items-end">
                      <div className="flex-1">
                        <Input
                          data-testid="ai-api-key-input"
                          label={t('settings.aiApiKey')}
                          type="password"
                          placeholder={
                            aiStatus?.enabled ? t('settings.aiKeyConfigured') : 'sk-ant-...'
                          }
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
                        onClick={() => saveAiKey(aiApiKey.trim())}
                      >
                        {t('common.save')}
                      </Button>
                    </div>
                    {aiKeySaved && (
                      <span className="text-xs text-[var(--sf-success)]" data-testid="ai-key-saved">
                        {t('settings.aiKeySaved')}
                      </span>
                    )}
                    {aiKeyError && (
                      <span className="text-xs text-[var(--sf-error)]">{aiKeyError}</span>
                    )}
                  </div>

                  <p className="text-xs text-text-secondary">{t('settings.aiHint')}</p>
                </div>
              </CardBody>
            </Card>
          </div>
        )}

        {activeTab === 'advanced' && (
          <div
            data-testid="advanced-settings"
            id="tabpanel-advanced"
            role="tabpanel"
            aria-labelledby="tab-advanced"
            className="flex flex-col gap-3"
          >
            <Card>
              <CardHeader title={t('settings.advanced')} />
              <CardBody>
                <div className="flex flex-col gap-3">
                  {/* Action buttons */}
                  <div className="flex gap-2 mt-2">
                    {onClearCache && (
                      <Button
                        data-testid="clear-cache-btn"
                        variant="secondary"
                        size="sm"
                        onClick={onClearCache}
                      >
                        {t('settings.clearCache')}
                      </Button>
                    )}
                    <Button
                      data-testid="reset-btn"
                      variant="secondary"
                      size="sm"
                      onClick={handleReset}
                    >
                      {t('settings.resetSettings')}
                    </Button>
                  </div>
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
                        className={`text-xs font-medium ${telemetryEnabled ? 'text-[var(--sf-success)]' : 'text-text-secondary'}`}
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
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-text-primary">
                      {t('settings.telemetryBufferSize')}
                    </span>
                    <span className="text-xs text-text-secondary">
                      {telemetryStatus ? telemetryStatus.bufferSize : '—'}
                    </span>
                  </div>
                  {telemetryToggleError && (
                    <span className="text-xs text-[var(--sf-error)]" data-testid="telemetry-error">
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

      {/* Save button */}
      <div className="flex justify-end mt-2">
        <Button data-testid="save-settings-btn" variant="primary" size="sm" onClick={handleSave}>
          {t('common.save')}
        </Button>
      </div>
    </div>
  );
};
