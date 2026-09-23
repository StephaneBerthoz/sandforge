import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import type { OrgDeviceCode } from '@sandforge/shared';
import { Button } from '../../components/ui/Button';
import { dateTimeFormat } from '../../utils/formatters';

/** Props of {@link DeviceCodePanel}. */
export interface DeviceCodePanelProps {
  /** The code Salesforce issued, the page to enter it on, and its expiry. */
  code: OrgDeviceCode;
  /** Stop the sign-in. */
  onCancel: () => void;
}

/**
 * What a device-flow sign-in shows while it waits: the code, the Salesforce
 * page to type it on, and when it stops working.
 *
 * The host opens the page in the browser too; the link is here for a browser
 * that did not open and for a user who approves on another device, which is
 * what the device flow is for. It replaces the form whose button the user
 * just pressed, so focus is moved onto the code rather than lost with the button.
 */
export const DeviceCodePanel: React.FC<DeviceCodePanelProps> = ({ code, onCancel }) => {
  const { t } = useTranslation();
  const codeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    codeRef.current?.focus();
  }, [code.userCode]);

  // The host only sends an https page on a Salesforce host; anything else is
  // shown as text and never made clickable.
  const link = code.verificationUri.startsWith('https://') ? code.verificationUri : null;
  const expiresAt = dateTimeFormat({ hour: '2-digit', minute: '2-digit' }).format(
    new Date(code.expiresAt),
  );

  return (
    <div className="grid gap-2 max-w-lg" data-testid="org-device-code">
      <div ref={codeRef} tabIndex={-1} role="status" className="grid gap-1 outline-none">
        <p className="text-xs text-text-secondary">{t('auth.deviceEnterCode')}</p>
        <p
          className="font-mono text-2xl font-semibold tracking-widest select-all text-text-primary"
          data-testid="org-device-user-code"
        >
          {code.userCode}
        </p>
      </div>
      <p className="text-xs text-text-secondary">
        {t('auth.deviceVerificationPage')}{' '}
        {link ? (
          <a
            href={link}
            target="_blank"
            rel="noreferrer"
            className="underline break-all text-[var(--sf-text-link)]"
            data-testid="org-device-verification-link"
          >
            {link}
          </a>
        ) : (
          <span className="break-all">{code.verificationUri}</span>
        )}
      </p>
      <p className="text-xs text-text-secondary">{t('auth.deviceExpires', { time: expiresAt })}</p>
      <p className="flex items-center gap-1.5 text-xs text-text-secondary">
        <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
        <span>{t('auth.deviceWaiting')}</span>
      </p>
      <div>
        <Button variant="secondary" size="sm" onClick={onCancel} data-testid="org-device-cancel">
          {t('auth.deviceCancel')}
        </Button>
      </div>
    </div>
  );
};
