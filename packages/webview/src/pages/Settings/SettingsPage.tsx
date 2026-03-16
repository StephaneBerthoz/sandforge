import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Tabs } from '../../components/ui/Tabs';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Select } from '../../components/ui/Select';
import { Input } from '../../components/ui/Input';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { useSettingsPageData } from './useSettingsPageData';

/** Settings values. */
export interface SettingsValues {
  language: string;
  theme: string;
  defaultBatchSize: number;
  maxConcurrentOps: number;
  enableGrappe: boolean;
  grappeThreshold: number;
  apiTimeout: number;
  retryAttempts: number;
  enableNotifications: boolean;
  soundAlerts: boolean;
  autoRefreshInterval: number;
  logLevel: string;
}

/** Default settings. */
export const defaultSettings: SettingsValues = {
  language: 'en',
  theme: 'auto',
  defaultBatchSize: 200,
  maxConcurrentOps: 3,
  enableGrappe: true,
  grappeThreshold: 10_000,
  apiTimeout: 30_000,
  retryAttempts: 3,
  enableNotifications: true,
  soundAlerts: false,
  autoRefreshInterval: 60,
  logLevel: 'info',
};

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
  } = useSettingsPageData(initialSettings, onSave, onReset);

  /** Telemetry state — static defaults until telemetry is fully implemented. */
  const [telemetryEnabled, setTelemetryEnabled] = useState(false);

  /** Plugins list — static defaults until plugin manager is fully implemented. */
  const plugins: Array<{ name: string; version: string; description: string; enabled: boolean }> = [];

  const tabs = [
    { id: 'general', label: t('settings.general') },
    { id: 'ai', label: t('settings.ai') },
    { id: 'notifications', label: t('settings.notifications') },
    { id: 'advanced', label: t('settings.advanced') },
    { id: 'plugins', label: t('settings.plugins') },
    { id: 'telemetry', label: t('settings.telemetry') },
  ];

  return (
    <div data-testid="settings-page" className="flex flex-col gap-3 p-4">
      <h1 className="text-lg font-bold text-[var(--vscode-editor-foreground,#d4d4d4)]">
        {t('settings.title')}
      </h1>

      <Tabs tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab} />

      <div className="mt-2">
        {activeTab === 'general' && (
          <div data-testid="general-settings" id="tabpanel-general" role="tabpanel" aria-labelledby="tab-general" className="flex flex-col gap-3">
            <Card>
              <CardHeader title={t('settings.general')} />
              <CardBody>
                <div className="flex flex-col gap-3">
                  {/* Language */}
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-[var(--vscode-editor-foreground,#d4d4d4)]">
                      {t('settings.language')}
                    </label>
                    <Select
                      data-testid="language-select"
                      aria-label={t('settings.language')}
                      options={[
                        { value: 'en', label: t('settings.languages.en') },
                        { value: 'fr', label: t('settings.languages.fr') },
                      ]}
                      value={settings.language}
                      onChange={(e) => updateSetting('language', e.target.value)}
                    />
                  </div>

                  {/* Theme */}
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-[var(--vscode-editor-foreground,#d4d4d4)]">
                      {t('settings.theme')}
                    </label>
                    <Select
                      data-testid="theme-select"
                      aria-label={t('settings.theme')}
                      options={[
                        { value: 'auto', label: t('settings.themes.auto') },
                        { value: 'light', label: t('settings.themes.light') },
                        { value: 'dark', label: t('settings.themes.dark') },
                      ]}
                      value={settings.theme}
                      onChange={(e) => updateSetting('theme', e.target.value)}
                    />
                  </div>

                  {/* Default Batch Size */}
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-[var(--vscode-editor-foreground,#d4d4d4)]">
                      {t('settings.defaultBatchSize')}
                    </label>
                    <input
                      data-testid="batch-size-input"
                      type="number"
                      aria-label={t('settings.defaultBatchSize')}
                      value={settings.defaultBatchSize}
                      onChange={(e) => updateSetting('defaultBatchSize', Number(e.target.value))}
                      className="px-2 py-1 text-xs rounded bg-[var(--vscode-input-background,#3c3c3c)] text-[var(--vscode-input-foreground,#cccccc)] border border-[var(--vscode-input-border,#3c3c3c)]"
                    />
                  </div>

                  {/* Max Concurrent Ops */}
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-[var(--vscode-editor-foreground,#d4d4d4)]">
                      {t('settings.maxConcurrentOps')}
                    </label>
                    <input
                      data-testid="concurrent-ops-input"
                      type="number"
                      aria-label={t('settings.maxConcurrentOps')}
                      value={settings.maxConcurrentOps}
                      onChange={(e) => updateSetting('maxConcurrentOps', Number(e.target.value))}
                      className="px-2 py-1 text-xs rounded bg-[var(--vscode-input-background,#3c3c3c)] text-[var(--vscode-input-foreground,#cccccc)] border border-[var(--vscode-input-border,#3c3c3c)]"
                    />
                  </div>
                </div>
              </CardBody>
            </Card>
          </div>
        )}

        {activeTab === 'ai' && (
          <div data-testid="ai-settings" id="tabpanel-ai" role="tabpanel" aria-labelledby="tab-ai" className="flex flex-col gap-3">
            <Card>
              <CardHeader title={t('settings.ai')} />
              <CardBody>
                <div className="flex flex-col gap-3">
                  {/* Status */}
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-[var(--vscode-editor-foreground,#d4d4d4)]">
                      {t('settings.aiStatus')}
                    </span>
                    <Badge variant={aiStatus?.enabled ? 'success' : 'default'}>
                      {aiStatus?.enabled
                        ? t('settings.aiEnabled')
                        : t('settings.aiDisabled')}
                    </Badge>
                  </div>

                  {aiStatus?.enabled && (
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-[var(--vscode-descriptionForeground,#868686)]">
                        {t('settings.aiModel')}
                      </span>
                      <span className="text-xs text-[var(--vscode-editor-foreground,#d4d4d4)] font-mono">
                        {aiStatus!.model}
                      </span>
                    </div>
                  )}

                  {/* API Key */}
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-[var(--vscode-editor-foreground,#d4d4d4)]">
                      {t('settings.aiApiKey')}
                    </label>
                    <div className="flex gap-2">
                      <div className="flex-1">
                        <Input
                          data-testid="ai-api-key-input"
                          type="password"
                          placeholder={aiStatus?.enabled ? t('settings.aiKeyConfigured') : 'sk-ant-...'}
                          value={aiApiKey}
                          onChange={(e) => { setAiApiKey(e.target.value); setAiKeySaved(false); }}
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
                      <span className="text-xs text-[var(--vscode-testing-iconPassed,#73c991)]" data-testid="ai-key-saved">
                        {t('settings.aiKeySaved')}
                      </span>
                    )}
                    {aiKeyError && (
                      <span className="text-xs text-[var(--vscode-errorForeground,#f48771)]">
                        {aiKeyError}
                      </span>
                    )}
                  </div>

                  <p className="text-xs text-[var(--vscode-descriptionForeground,#868686)]">
                    {t('settings.aiHint')}
                  </p>
                </div>
              </CardBody>
            </Card>
          </div>
        )}

        {activeTab === 'notifications' && (
          <div data-testid="notification-settings" id="tabpanel-notifications" role="tabpanel" aria-labelledby="tab-notifications" className="flex flex-col gap-3">
            <Card>
              <CardHeader title={t('settings.notifications')} />
              <CardBody>
                <div className="flex flex-col gap-3">
                  {/* Enable Notifications */}
                  <label className="flex items-center gap-2 text-xs text-[var(--vscode-editor-foreground,#d4d4d4)]">
                    <input
                      data-testid="enable-notifications-checkbox"
                      type="checkbox"
                      checked={settings.enableNotifications}
                      onChange={(e) => updateSetting('enableNotifications', e.target.checked)}
                    />
                    {t('settings.enableNotifications')}
                  </label>

                  {/* Sound Alerts */}
                  <label className="flex items-center gap-2 text-xs text-[var(--vscode-editor-foreground,#d4d4d4)]">
                    <input
                      data-testid="sound-alerts-checkbox"
                      type="checkbox"
                      checked={settings.soundAlerts}
                      onChange={(e) => updateSetting('soundAlerts', e.target.checked)}
                    />
                    {t('settings.soundAlerts')}
                  </label>

                  {/* Auto-Refresh Interval */}
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-[var(--vscode-editor-foreground,#d4d4d4)]">
                      {t('settings.autoRefreshInterval')}
                    </label>
                    <input
                      data-testid="refresh-interval-input"
                      type="number"
                      value={settings.autoRefreshInterval}
                      onChange={(e) => updateSetting('autoRefreshInterval', Number(e.target.value))}
                      className="px-2 py-1 text-xs rounded bg-[var(--vscode-input-background,#3c3c3c)] text-[var(--vscode-input-foreground,#cccccc)] border border-[var(--vscode-input-border,#3c3c3c)]"
                    />
                  </div>
                </div>
              </CardBody>
            </Card>
          </div>
        )}

        {activeTab === 'advanced' && (
          <div data-testid="advanced-settings" id="tabpanel-advanced" role="tabpanel" aria-labelledby="tab-advanced" className="flex flex-col gap-3">
            <Card>
              <CardHeader title={t('settings.advanced')} />
              <CardBody>
                <div className="flex flex-col gap-3">
                  {/* Enable Grappe */}
                  <div className="flex flex-col gap-0.5">
                    <label className="flex items-center gap-2 text-xs text-[var(--vscode-editor-foreground,#d4d4d4)]">
                      <input
                        data-testid="enable-grappe-checkbox"
                        type="checkbox"
                        checked={settings.enableGrappe}
                        onChange={(e) => updateSetting('enableGrappe', e.target.checked)}
                      />
                      {t('settings.enableGrappe')}
                    </label>
                    <p className="text-[10px] text-[var(--vscode-descriptionForeground,#868686)] ml-5">
                      {t('settings.enableGrappeDesc')}
                    </p>
                  </div>

                  {/* Grappe Threshold */}
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-[var(--vscode-editor-foreground,#d4d4d4)]">
                      {t('settings.grappeThreshold')}
                    </label>
                    <input
                      data-testid="grappe-threshold-input"
                      type="number"
                      value={settings.grappeThreshold}
                      onChange={(e) => updateSetting('grappeThreshold', Number(e.target.value))}
                      className="px-2 py-1 text-xs rounded bg-[var(--vscode-input-background,#3c3c3c)] text-[var(--vscode-input-foreground,#cccccc)] border border-[var(--vscode-input-border,#3c3c3c)]"
                    />
                  </div>

                  {/* API Timeout */}
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-[var(--vscode-editor-foreground,#d4d4d4)]">
                      {t('settings.apiTimeout')}
                    </label>
                    <input
                      data-testid="api-timeout-input"
                      type="number"
                      value={settings.apiTimeout}
                      onChange={(e) => updateSetting('apiTimeout', Number(e.target.value))}
                      className="px-2 py-1 text-xs rounded bg-[var(--vscode-input-background,#3c3c3c)] text-[var(--vscode-input-foreground,#cccccc)] border border-[var(--vscode-input-border,#3c3c3c)]"
                    />
                  </div>

                  {/* Log Level */}
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-[var(--vscode-editor-foreground,#d4d4d4)]">
                      {t('settings.logLevel')}
                    </label>
                    <Select
                      data-testid="log-level-select"
                      options={[
                        { value: 'debug', label: t('settings.logLevels.debug') },
                        { value: 'info', label: t('settings.logLevels.info') },
                        { value: 'warn', label: t('settings.logLevels.warn') },
                        { value: 'error', label: t('settings.logLevels.error') },
                      ]}
                      value={settings.logLevel}
                      onChange={(e) => updateSetting('logLevel', e.target.value)}
                    />
                  </div>

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

        {activeTab === 'plugins' && (
          <div data-testid="plugins-settings" id="tabpanel-plugins" role="tabpanel" aria-labelledby="tab-plugins" className="flex flex-col gap-3">
            <Card>
              <CardHeader title={t('settings.plugins')} />
              <CardBody>
                <div className="flex flex-col gap-3">
                  {plugins.length > 0 ? (
                    plugins.map((plugin) => (
                      <div
                        key={plugin.name}
                        className="flex items-center justify-between p-2 rounded border border-[var(--vscode-panel-border,#2b2b2b)] bg-[var(--vscode-editor-background,#1e1e1e)]"
                        data-testid={`plugin-${plugin.name}`}
                      >
                        <div className="flex flex-col">
                          <span className="text-xs font-medium text-[var(--vscode-editor-foreground,#d4d4d4)]">
                            {plugin.name} <span className="text-[var(--vscode-descriptionForeground,#868686)]">v{plugin.version}</span>
                          </span>
                          <span className="text-xs text-[var(--vscode-descriptionForeground,#868686)]">
                            {plugin.description}
                          </span>
                        </div>
                        <span className={`text-xs px-2 py-0.5 rounded ${plugin.enabled ? 'text-[var(--vscode-testing-iconPassed,#73c991)] bg-[var(--vscode-testing-iconPassed,#73c991)]/10' : 'text-[var(--vscode-descriptionForeground,#868686)] bg-[var(--vscode-descriptionForeground,#868686)]/10'}`}>
                          {plugin.enabled ? t('settings.pluginEnabled') : t('settings.pluginDisabled')}
                        </span>
                      </div>
                    ))
                  ) : (
                    <p className="text-xs text-[var(--vscode-descriptionForeground,#868686)]">
                      {t('settings.noPlugins')}
                    </p>
                  )}
                </div>
              </CardBody>
            </Card>
          </div>
        )}

        {activeTab === 'telemetry' && (
          <div data-testid="telemetry-settings" id="tabpanel-telemetry" role="tabpanel" aria-labelledby="tab-telemetry" className="flex flex-col gap-3">
            <Card>
              <CardHeader title={t('settings.telemetry')} />
              <CardBody>
                <div className="flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-[var(--vscode-editor-foreground,#d4d4d4)]">
                      {t('settings.telemetryStatus')}
                    </span>
                    <span className={`text-xs font-medium ${telemetryEnabled ? 'text-[var(--vscode-testing-iconPassed,#73c991)]' : 'text-[var(--vscode-descriptionForeground,#868686)]'}`}>
                      {telemetryEnabled ? t('settings.telemetryEnabled') : t('settings.telemetryDisabled')}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-[var(--vscode-editor-foreground,#d4d4d4)]">
                      {t('settings.telemetryEventCount')}
                    </span>
                    <span className="text-xs text-[var(--vscode-descriptionForeground,#868686)]">0</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-[var(--vscode-editor-foreground,#d4d4d4)]">
                      {t('settings.telemetryBufferSize')}
                    </span>
                    <span className="text-xs text-[var(--vscode-descriptionForeground,#868686)]">0</span>
                  </div>
                  <Button
                    data-testid="telemetry-toggle-btn"
                    variant="secondary"
                    size="sm"
                    onClick={() => setTelemetryEnabled((prev) => !prev)}
                  >
                    {telemetryEnabled ? t('settings.telemetryDisable') : t('settings.telemetryEnable')}
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
