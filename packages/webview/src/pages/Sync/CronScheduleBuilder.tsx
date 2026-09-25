import React, { useState, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Icon } from '../../components/ui/Icon';
import { uiLocale } from '../../utils/formatters';

/** Data submitted by the cron schedule builder form. */
export interface CronScheduleFormData {
  /** Human-readable name for the schedule. */
  name: string;
  /** 5-field cron expression. */
  cron: string;
  /** IANA timezone string. */
  timezone: string;
  /** ID of the sync config to execute. */
  configId: string;
  /** Maximum retry attempts on failure. */
  maxRetries: number;
  /** Whether to notify on successful completion. */
  notifyOnComplete: boolean;
  /** Whether to notify on failure. */
  notifyOnFailure: boolean;
}

/** Props for the CronScheduleBuilder component. */
export interface CronScheduleBuilderProps {
  /** Initial cron expression for editing. */
  initialCron?: string;
  /** Initial timezone for editing. */
  initialTimezone?: string;
  /** Initial schedule name for editing. */
  initialName?: string;
  /** Initial config ID for editing. */
  initialConfigId?: string;
  /** Initial max retries for editing. */
  initialMaxRetries?: number;
  /** Initial notifyOnComplete for editing. */
  initialNotifyOnComplete?: boolean;
  /** Initial notifyOnFailure for editing. */
  initialNotifyOnFailure?: boolean;
  /** Callback when the form is submitted. */
  onSubmit: (data: CronScheduleFormData) => void;
  /** Callback when the form is cancelled. */
  onCancel: () => void;
  /** Available sync configs to schedule. */
  configs: Array<{ id: string; name: string }>;
}

/** Frequency presets for simple mode. */
type FrequencyPreset = 'hourly' | 'daily' | 'weekly' | 'monthly' | 'custom';

/** Day-of-week labels. */
const DAYS_OF_WEEK = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;
const DAYS_CRON_MAP: Record<string, string> = {
  MON: '1',
  TUE: '2',
  WED: '3',
  THU: '4',
  FRI: '5',
  SAT: '6',
  SUN: '0',
};

/**
 * Generate available timezone options using Intl API.
 * Falls back to a small set if Intl.supportedValuesOf is not available.
 */
export function getTimezones(): string[] {
  try {
    if (typeof Intl !== 'undefined' && 'supportedValuesOf' in Intl) {
      return (
        Intl as unknown as { supportedValuesOf: (key: string) => string[] }
      ).supportedValuesOf('timeZone');
    }
  } catch {
    // fallback below
  }
  return [
    'UTC',
    'America/New_York',
    'America/Chicago',
    'America/Denver',
    'America/Los_Angeles',
    'Europe/London',
    'Europe/Paris',
    'Asia/Tokyo',
  ];
}

/** Get the user's local timezone. */
export function getLocalTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
}

/**
 * The name of a day of the week in `locale`, from its cron number (0 and 7
 * are Sunday), or undefined for anything else.
 */
function weekdayName(cronDay: string, locale: string, width: 'long' | 'short'): string | undefined {
  if (!/^[0-7]$/.test(cronDay)) return undefined;
  // 7 January 2024 was a Sunday.
  return new Intl.DateTimeFormat(locale, { weekday: width, timeZone: 'UTC' }).format(
    Date.UTC(2024, 0, 7 + (Number(cronDay) % 7)),
  );
}

/**
 * Convert a cron expression to a description in the language of the page.
 * Handles common patterns; falls back to raw cron for complex expressions.
 *
 * It used to write English in every language, day names included ("Every
 * MON, WED at 09:00"), on the schedule cards and in the builder's preview.
 *
 * @param cron - A 5-field cron expression.
 * @param t - The translation function of the page.
 * @param locale - Where the day names come from; the page's by default.
 */
export function cronToHuman(cron: string, t: TFunction, locale: string = uiLocale()): string {
  const parts = cron.split(' ');
  if (parts.length !== 5) return cron;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  const atTime = /^\d+$/.test(minute) && /^\d+$/.test(hour);
  const time = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;

  if (minute === '0' && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return t('sync.schedules.cron.hourly');
  }
  if (!atTime || month !== '*') return cron;
  if (dayOfMonth === '*' && dayOfWeek === '*') {
    return t('sync.schedules.cron.daily', { time });
  }
  if (dayOfMonth === '*') {
    const days = dayOfWeek
      .split(',')
      .map((d) => weekdayName(d, locale, 'long') ?? d)
      .join(t('sync.schedules.cron.daySeparator'));
    return t('sync.schedules.cron.weekly', { days, time });
  }
  if (dayOfWeek === '*') {
    return t('sync.schedules.cron.monthly', { day: dayOfMonth, time });
  }

  return cron;
}

/**
 * CronScheduleBuilder provides a form for creating/editing cron schedules.
 * Supports Simple mode (preset frequency pickers) and Advanced mode (raw cron input).
 */
export const CronScheduleBuilder: React.FC<CronScheduleBuilderProps> = ({
  initialCron,
  initialTimezone,
  initialName = '',
  initialConfigId = '',
  initialMaxRetries = 3,
  initialNotifyOnComplete = false,
  initialNotifyOnFailure = true,
  onSubmit,
  onCancel,
  configs,
}) => {
  const { t } = useTranslation();
  const timezones = useMemo(() => getTimezones(), []);

  // Form state
  const [name, setName] = useState(initialName);
  // An edited schedule whose configuration is gone starts with none picked:
  // preselecting another one moved the schedule onto a different org pair
  // as soon as any other field was saved.
  const initialConfigGone =
    initialConfigId !== '' && !configs.some((c) => c.id === initialConfigId);
  const [configId, setConfigId] = useState(
    initialConfigGone ? '' : initialConfigId || (configs[0]?.id ?? ''),
  );
  const configPicked = configs.some((c) => c.id === configId);
  const [mode, setMode] = useState<'simple' | 'advanced'>(
    initialCron && !isSimpleCron(initialCron) ? 'advanced' : 'simple',
  );
  const [timezone, setTimezone] = useState(initialTimezone ?? getLocalTimezone());
  const [maxRetries, setMaxRetries] = useState(initialMaxRetries);
  const [notifyOnComplete, setNotifyOnComplete] = useState(initialNotifyOnComplete);
  const [notifyOnFailure, setNotifyOnFailure] = useState(initialNotifyOnFailure);
  const [timezoneSearch, setTimezoneSearch] = useState('');

  // Simple mode state
  const [preset, setPreset] = useState<FrequencyPreset>('daily');
  const [hour, setHour] = useState(initialCron ? parseCronHour(initialCron) : 9);
  const [minute, setMinute] = useState(initialCron ? parseCronMinute(initialCron) : 0);
  const [dayOfWeek, setDayOfWeek] = useState<string[]>(
    initialCron ? parseCronDayOfWeek(initialCron) : ['MON'],
  );
  const [dayOfMonth, setDayOfMonth] = useState(initialCron ? parseCronDayOfMonth(initialCron) : 1);

  // Advanced mode state
  const [rawCron, setRawCron] = useState(initialCron ?? '0 9 * * *');

  const filteredTimezones = useMemo(() => {
    if (!timezoneSearch.trim()) return timezones.slice(0, 50);
    const query = timezoneSearch.toLowerCase();
    return timezones.filter((tz) => tz.toLowerCase().includes(query)).slice(0, 50);
  }, [timezones, timezoneSearch]);

  /** Build cron from simple mode selections. */
  const buildSimpleCron = useCallback((): string => {
    switch (preset) {
      case 'hourly':
        return '0 * * * *';
      case 'daily':
        return `${minute} ${hour} * * *`;
      case 'weekly':
        return `${minute} ${hour} * * ${dayOfWeek.map((d) => DAYS_CRON_MAP[d]).join(',')}`;
      case 'monthly':
        return `${minute} ${hour} ${dayOfMonth} * *`;
      case 'custom':
        return rawCron;
      default:
        return '0 9 * * *';
    }
  }, [preset, hour, minute, dayOfWeek, dayOfMonth, rawCron]);

  const currentCron = mode === 'simple' ? buildSimpleCron() : rawCron;

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!configPicked) return;
      onSubmit({
        name,
        cron: currentCron,
        timezone,
        configId,
        maxRetries,
        notifyOnComplete,
        notifyOnFailure,
      });
    },
    [
      name,
      currentCron,
      timezone,
      configId,
      maxRetries,
      notifyOnComplete,
      notifyOnFailure,
      configPicked,
      onSubmit,
    ],
  );

  const inputClass =
    'w-full px-2 py-1 text-xs rounded-sm border border-(--sf-border-input) bg-(--sf-bg-input) text-(--sf-text-input) focus:outline-hidden focus:border-(--sf-accent)';
  const labelClass = 'text-[10px] font-semibold text-text-primary mb-1';

  return (
    <form
      className="flex flex-col gap-(--sf-space-3) p-(--sf-space-3) border border-(--sf-border) rounded-sm"
      onSubmit={handleSubmit}
      data-testid="cron-schedule-builder"
    >
      <h4 className="text-sm font-semibold text-text-primary">
        {t('sync.schedules.builderTitle')}
      </h4>

      {/* Name */}
      <label className="flex flex-col gap-1">
        <span className={labelClass}>{t('sync.schedules.name')}</span>
        <input
          type="text"
          className={inputClass}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('sync.schedules.namePlaceholder')}
          required
          data-testid="schedule-name-input"
        />
      </label>

      {/* Config selector */}
      <label className="flex flex-col gap-1">
        <span className={labelClass}>{t('sync.schedules.syncConfig')}</span>
        <select
          className={inputClass}
          value={configId}
          onChange={(e) => setConfigId(e.target.value)}
          data-testid="config-selector"
        >
          {!configPicked && (
            <option value="" disabled>
              {t('sync.schedules.configGone')}
            </option>
          )}
          {configs.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>

      {/* Mode toggle */}
      <div className="flex gap-(--sf-space-2)">
        <button
          type="button"
          className={`text-xs px-3 py-1 rounded-sm ${mode === 'simple' ? 'bg-(--sf-button-bg) text-(--sf-button-fg)' : 'bg-(--sf-button-secondary-bg) text-(--sf-button-secondary-fg)'}`}
          onClick={() => setMode('simple')}
          data-testid="mode-simple-btn"
        >
          {t('sync.schedules.simpleMode')}
        </button>
        <button
          type="button"
          className={`text-xs px-3 py-1 rounded-sm ${mode === 'advanced' ? 'bg-(--sf-button-bg) text-(--sf-button-fg)' : 'bg-(--sf-button-secondary-bg) text-(--sf-button-secondary-fg)'}`}
          onClick={() => setMode('advanced')}
          data-testid="mode-advanced-btn"
        >
          {t('sync.schedules.advancedMode')}
        </button>
      </div>

      {/* Simple mode */}
      {mode === 'simple' && (
        <div className="flex flex-col gap-(--sf-space-2)" data-testid="simple-mode-panel">
          {/* Preset selector */}
          <label className="flex flex-col gap-1">
            <span className={labelClass}>{t('sync.schedules.frequency')}</span>
            <select
              className={inputClass}
              value={preset}
              onChange={(e) => setPreset(e.target.value as FrequencyPreset)}
              data-testid="preset-selector"
            >
              <option value="hourly">{t('sync.schedules.presetHourly')}</option>
              <option value="daily">{t('sync.schedules.presetDaily')}</option>
              <option value="weekly">{t('sync.schedules.presetWeekly')}</option>
              <option value="monthly">{t('sync.schedules.presetMonthly')}</option>
            </select>
          </label>

          {/* Time picker (for daily/weekly/monthly) */}
          {preset !== 'hourly' && (
            <div className="flex gap-(--sf-space-2)">
              <label className="flex flex-col gap-1">
                <span className={labelClass}>{t('sync.schedules.hour')}</span>
                <select
                  className={inputClass}
                  value={hour}
                  onChange={(e) => setHour(Number(e.target.value))}
                  data-testid="hour-selector"
                >
                  {Array.from({ length: 24 }, (_, i) => (
                    <option key={i} value={i}>
                      {String(i).padStart(2, '0')}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className={labelClass}>{t('sync.schedules.minute')}</span>
                <select
                  className={inputClass}
                  value={minute}
                  onChange={(e) => setMinute(Number(e.target.value))}
                  data-testid="minute-selector"
                >
                  {[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map((m) => (
                    <option key={m} value={m}>
                      {String(m).padStart(2, '0')}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}

          {/* Day-of-week picker (for weekly) */}
          {preset === 'weekly' && (
            <div>
              {/* Toggle buttons are not labelable, so the caption names a group
                  instead of a control. */}
              <span className={labelClass}>{t('sync.schedules.daysOfWeek')}</span>
              <div className="flex gap-1" role="group" aria-label={t('sync.schedules.daysOfWeek')}>
                {DAYS_OF_WEEK.map((day) => (
                  <button
                    key={day}
                    type="button"
                    className={`text-[10px] px-2 py-1 rounded ${
                      dayOfWeek.includes(day)
                        ? 'bg-(--sf-button-bg) text-(--sf-button-fg)'
                        : 'bg-(--sf-button-secondary-bg) text-(--sf-button-secondary-fg)'
                    }`}
                    // Picked or not was told by the fill alone.
                    aria-pressed={dayOfWeek.includes(day)}
                    onClick={() => {
                      setDayOfWeek((prev) =>
                        prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day],
                      );
                    }}
                    data-testid={`day-btn-${day}`}
                  >
                    {weekdayName(DAYS_CRON_MAP[day], uiLocale(), 'short') ?? day}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Day-of-month picker (for monthly) */}
          {preset === 'monthly' && (
            <label className="flex flex-col gap-1">
              <span className={labelClass}>{t('sync.schedules.dayOfMonth')}</span>
              <select
                className={inputClass}
                value={dayOfMonth}
                onChange={(e) => setDayOfMonth(Number(e.target.value))}
                data-testid="day-of-month-selector"
              >
                {Array.from({ length: 28 }, (_, i) => (
                  <option key={i + 1} value={i + 1}>
                    {i + 1}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}

      {/* Advanced mode */}
      {mode === 'advanced' && (
        <div data-testid="advanced-mode-panel">
          <label className="flex flex-col gap-1">
            <span className={labelClass}>{t('sync.schedules.cronExpression')}</span>
            <input
              type="text"
              className={inputClass}
              value={rawCron}
              onChange={(e) => setRawCron(e.target.value)}
              placeholder="* * * * *"
              data-testid="raw-cron-input"
            />
          </label>
          <p className="text-[10px] text-text-secondary mt-1">{t('sync.schedules.cronHelp')}</p>
        </div>
      )}

      {/* Timezone */}
      <div>
        {/* Two controls under one caption: a wrapping label would bind to the
            search box only, so each control carries its own name. */}
        <span className={labelClass}>{t('sync.schedules.timezone')}</span>
        <input
          type="text"
          className={`${inputClass} mb-1`}
          value={timezoneSearch}
          onChange={(e) => setTimezoneSearch(e.target.value)}
          placeholder={t('sync.schedules.searchTimezone')}
          aria-label={t('sync.schedules.searchTimezone')}
          data-testid="timezone-search"
        />
        <select
          className={inputClass}
          value={timezone}
          onChange={(e) => setTimezone(e.target.value)}
          aria-label={t('sync.schedules.timezone')}
          data-testid="timezone-selector"
        >
          {filteredTimezones.map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </select>
      </div>

      {/* Options */}
      <div className="flex flex-col gap-(--sf-space-1)">
        <span className={labelClass}>{t('sync.schedules.options')}</span>
        <label className="flex items-center gap-(--sf-space-2) text-[10px] text-text-primary">
          {t('sync.schedules.maxRetries')}
          <input
            type="number"
            className="w-16 px-1 py-0.5 text-xs rounded-sm border border-(--sf-border-input) bg-(--sf-bg-input) text-(--sf-text-input)"
            value={maxRetries}
            onChange={(e) => setMaxRetries(Number(e.target.value))}
            min={0}
            max={10}
            data-testid="max-retries-input"
          />
        </label>
        <label className="flex items-center gap-1 text-[10px] text-text-primary">
          <input
            type="checkbox"
            checked={notifyOnComplete}
            onChange={(e) => setNotifyOnComplete(e.target.checked)}
            data-testid="notify-complete-checkbox"
          />
          {t('sync.schedules.notifyOnComplete')}
        </label>
        <label className="flex items-center gap-1 text-[10px] text-text-primary">
          <input
            type="checkbox"
            checked={notifyOnFailure}
            onChange={(e) => setNotifyOnFailure(e.target.checked)}
            data-testid="notify-failure-checkbox"
          />
          {t('sync.schedules.notifyOnFailure')}
        </label>
      </div>

      {/* Preview */}
      <div
        className="text-[10px] text-text-secondary bg-(--sf-bg-primary) rounded-sm p-2"
        data-testid="cron-preview"
      >
        <span className="font-semibold">{t('sync.schedules.preview')}:</span>{' '}
        {cronToHuman(currentCron, t)}
      </div>

      {/* Actions */}
      <div className="flex justify-end gap-(--sf-space-2)">
        <button
          type="button"
          className="text-xs px-3 py-1.5 rounded-sm bg-(--sf-button-secondary-bg) text-(--sf-button-secondary-fg) hover:bg-(--sf-button-secondary-hover)"
          onClick={onCancel}
          data-testid="cancel-btn"
        >
          <Icon name="close" /> {t('common.cancel')}
        </button>
        <button
          type="submit"
          className="text-xs px-3 py-1.5 rounded-sm bg-(--sf-button-bg) text-(--sf-button-fg) hover:bg-(--sf-button-hover) disabled:opacity-50"
          disabled={!configPicked}
          data-testid="submit-btn"
        >
          <Icon name="check" /> {t('common.save')}
        </button>
      </div>
    </form>
  );
};

/** Check if a cron expression matches a simple preset pattern. */
function isSimpleCron(cron: string): boolean {
  const parts = cron.split(' ');
  if (parts.length !== 5) return false;
  // Hourly, daily, weekly, monthly all have at most specific numeric values
  return parts.every((p) => /^[\d,*]+$/.test(p));
}

/** Parse hour from cron expression (defaults to 9). */
function parseCronHour(cron: string): number {
  const parts = cron.split(' ');
  if (parts.length < 2 || parts[1] === '*') return 9;
  return parseInt(parts[1], 10) || 9;
}

/** Parse minute from cron expression (defaults to 0). */
function parseCronMinute(cron: string): number {
  const parts = cron.split(' ');
  if (parts.length < 1 || parts[0] === '*') return 0;
  return parseInt(parts[0], 10) || 0;
}

/** Parse day-of-week from cron expression. */
function parseCronDayOfWeek(cron: string): string[] {
  const parts = cron.split(' ');
  if (parts.length < 5 || parts[4] === '*') return ['MON'];
  return parts[4].split(',').map((d) => {
    const entry = Object.entries(DAYS_CRON_MAP).find(([, v]) => v === d);
    return entry ? entry[0] : 'MON';
  });
}

/** Parse day-of-month from cron expression (defaults to 1). */
function parseCronDayOfMonth(cron: string): number {
  const parts = cron.split(' ');
  if (parts.length < 3 || parts[2] === '*') return 1;
  return parseInt(parts[2], 10) || 1;
}
