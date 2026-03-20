import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Clock } from 'lucide-react';

/**
 * Compute milliseconds until midnight Pacific (America/Los_Angeles).
 *
 * Salesforce daily limits reset at midnight Pacific time.
 * This function uses Intl.DateTimeFormat to determine the current
 * Pacific time, then calculates the remaining ms until 00:00:00.
 */
function msUntilMidnightPacific(): number {
  const now = new Date();

  // Format the current time in Pacific timezone to extract components
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(now);
  const get = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? '0');

  const pacificHour = get('hour') === 24 ? 0 : get('hour');
  const pacificMinute = get('minute');
  const pacificSecond = get('second');

  // Total seconds elapsed today in Pacific
  const elapsedSeconds = pacificHour * 3600 + pacificMinute * 60 + pacificSecond;
  const totalSecondsInDay = 24 * 3600;
  const remainingMs = (totalSecondsInDay - elapsedSeconds) * 1000;

  return remainingMs;
}

/**
 * Format milliseconds as HH:MM:SS string.
 */
function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
}

/**
 * Displays a countdown timer (HH:MM:SS) until midnight Pacific time.
 *
 * Salesforce daily limits (DailyApiRequests, DailyWorkflowEmails, etc.)
 * reset at midnight Pacific (America/Los_Angeles). This component
 * provides real-time awareness of how much time remains before reset.
 */
export const ResetCountdown: React.FC = () => {
  const { t } = useTranslation();

  const computeRemaining = useCallback(() => msUntilMidnightPacific(), []);
  const [remaining, setRemaining] = useState(computeRemaining);

  useEffect(() => {
    const interval = setInterval(() => {
      setRemaining(msUntilMidnightPacific());
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <span
      className="flex items-center gap-1 text-xs text-text-muted tabular-nums"
      data-testid="reset-countdown"
    >
      <Clock className="w-3 h-3" />
      <span>{t('monitor.resetIn', 'Reset in')}</span>
      <span data-testid="reset-countdown-value">{formatCountdown(remaining)}</span>
    </span>
  );
};
