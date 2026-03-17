import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { AuthMethod } from '@sandforge/shared';
import { Dialog } from '../../components/ui/Dialog';
import { Input } from '../../components/ui/Input';
import { Select } from '../../components/ui/Select';
import { Button } from '../../components/ui/Button';

/** ConnectOrgPayload — the data sent when the user clicks Connect. */
export interface ConnectOrgPayload {
  alias: string;
  authMethod: AuthMethod;
  loginUrl: string;
  username?: string;
  password?: string;
  securityToken?: string;
}

/** OrgConnectDialog component props. */
export interface OrgConnectDialogProps {
  open: boolean;
  onClose: () => void;
  onConnect: (payload: ConnectOrgPayload) => void;
  isConnecting?: boolean;
}

/** Dialog for connecting a new Salesforce org. */
export const OrgConnectDialog: React.FC<OrgConnectDialogProps> = ({
  open,
  onClose,
  onConnect,
  isConnecting,
}) => {
  const { t } = useTranslation();

  const authOptions = [
    { value: 'oauth_web', label: t('auth.oauthWeb') },
    { value: 'oauth_device', label: t('auth.oauthDevice') },
    { value: 'jwt', label: t('auth.jwt') },
    { value: 'usernamePassword', label: t('auth.usernamePassword') },
    { value: 'sfdx_import', label: t('auth.sfdxImport') },
  ];

  const loginUrlOptions = [
    { value: 'https://login.salesforce.com', label: t('auth.loginProduction') },
    { value: 'https://test.salesforce.com', label: t('auth.loginSandbox') },
  ];
  const [alias, setAlias] = useState('');
  const [authMethod, setAuthMethod] = useState<AuthMethod>('sfdx_import');
  const [loginUrl, setLoginUrl] = useState('https://login.salesforce.com');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [securityToken, setSecurityToken] = useState('');

  const isSfdxImport = authMethod === 'sfdx_import';
  const isUsernamePassword = authMethod === 'usernamePassword';
  const isOAuthWeb = authMethod === 'oauth_web';
  const isNotSupported = authMethod === 'oauth_device' || authMethod === 'jwt';

  const canConnect = isSfdxImport
    || (isUsernamePassword && alias.trim() && username.trim() && password.trim())
    || (isOAuthWeb && alias.trim())
    || isNotSupported;

  const handleConnect = useCallback(() => {
    if (!canConnect) return;
    onConnect({
      alias: alias.trim(),
      authMethod,
      loginUrl,
      ...(isUsernamePassword ? { username: username.trim(), password, securityToken: securityToken.trim() } : {}),
    });
  }, [alias, authMethod, loginUrl, username, password, securityToken, isUsernamePassword, canConnect, onConnect]);

  const handleClose = useCallback(() => {
    setAlias('');
    setAuthMethod('sfdx_import');
    setLoginUrl('https://login.salesforce.com');
    setUsername('');
    setPassword('');
    setSecurityToken('');
    onClose();
  }, [onClose]);

  const connectButtonLabel = isSfdxImport
    ? t('auth.importAll')
    : isOAuthWeb
      ? t('auth.openBrowser')
      : t('org.connect');

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title={t('org.connect')}
      description={t('org.connect')}
      footer={
        <>
          <Button variant="secondary" onClick={handleClose}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={handleConnect}
            loading={isConnecting}
            disabled={!canConnect}
          >
            {connectButtonLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Select
          label={t('auth.method')}
          options={authOptions}
          value={authMethod}
          onChange={(e) => setAuthMethod(e.target.value as AuthMethod)}
        />

        {!isSfdxImport && (
          <Select
            label={t('auth.loginUrl')}
            options={loginUrlOptions}
            value={loginUrl}
            onChange={(e) => setLoginUrl(e.target.value)}
          />
        )}

        {(isUsernamePassword || isOAuthWeb) && (
          <Input
            label={t('org.alias')}
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
            placeholder={t('org.aliasPlaceholder')}
            data-testid="alias-input"
          />
        )}

        {isUsernamePassword && (
          <>
            <Input
              label={t('auth.username')}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={t('auth.usernamePlaceholder')}
              data-testid="username-input"
            />
            <Input
              label={t('auth.password')}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              data-testid="password-input"
            />
            <Input
              label={t('auth.securityToken')}
              value={securityToken}
              onChange={(e) => setSecurityToken(e.target.value)}
              placeholder={t('auth.securityTokenHint')}
              data-testid="security-token-input"
            />
          </>
        )}

        {isNotSupported && (
          <p className="text-sm text-[var(--vscode-descriptionForeground,#888)]">
            {t('auth.notSupported')}
          </p>
        )}

        {isSfdxImport && (
          <p className="text-sm text-[var(--vscode-descriptionForeground,#888)]">
            {t('auth.sfdxHint')}
          </p>
        )}
      </div>
    </Dialog>
  );
};
