import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Plug,
  Download,
  Globe,
  Smartphone,
  Key,
  UserCircle,
  Loader2,
  X,
  ChevronDown,
  CheckCircle,
} from 'lucide-react';
import type { SalesforceOrg, AuthMethod, BaseMessage, OrgDeviceCode } from '@sandforge/shared';
import {
  SF_CLI_INSTALL_URL,
  SF_CLI_MISSING_MESSAGE,
  SF_DEVICE_CODE_LIFETIME_MS,
  bannerHintOf,
} from '@sandforge/shared';
import { cn } from '../../theme';
import { useOrgStore } from '../../stores/useOrgStore';
import { useAppStore } from '../../stores/useAppStore';
import { sendBridgeMessage } from '../../bridge/sendBridgeMessage';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { useMessageListener } from '../../hooks/useMessageBus';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Select } from '../../components/ui/Select';
import { EmptyState } from '../../components/ui/EmptyState';
import { DangerConfirm } from '../../components/ui/DangerConfirm';
import { OrgCard } from './OrgCard';
import { OrgEditDialog } from './OrgEditDialog';
import type { OrgEditPayload } from './OrgEditDialog';
import { DeviceCodePanel } from './DeviceCodePanel';
import { DisconnectBackups } from './DisconnectBackups';
import { canFill, orgToFill } from '../../utils/orgToFill';
import { ErrorExplanation } from '../../components/ui/ErrorExplanation';

/** What the inline connect form submits for a new org. */
interface ConnectOrgPayload {
  alias: string;
  authMethod: AuthMethod;
  loginUrl: string;
  username?: string;
  password?: string;
  securityToken?: string;
  /** JWT and device flow: the consumer key of the user's own app. */
  clientId?: string;
  /** JWT: the private key file's path, which the host hands to the CLI unopened. */
  jwtKeyFile?: string;
}

/**
 * How long the page waits on a device sign-in: the code's ten minutes, plus
 * what the host may spend around them, each step bounded there — the CLI
 * check and the code request before, and after an approval given at the last
 * moment, the last poll, the hand-off to the CLI and the import (under three
 * minutes in all).
 */
const DEVICE_SIGN_IN_TIMEOUT_MS = SF_DEVICE_CODE_LIFETIME_MS + 240_000;

/** The device code a host message carries, or null when it carries none that can be shown. */
function readDeviceCode(payload: unknown): OrgDeviceCode | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { userCode, verificationUri, expiresAt } = payload as Record<string, unknown>;
  if (typeof userCode !== 'string' || userCode.length === 0) return null;
  if (typeof verificationUri !== 'string' || typeof expiresAt !== 'number') return null;
  return { userCode, verificationUri, expiresAt };
}

/** Payload shape returned by org:list:response. */
interface OrgListPayload {
  orgs: SalesforceOrg[];
}

/** Payload shape returned by org:statusChanged. */
interface OrgStatusPayload {
  orgId: string;
  status: string;
}

/** What the host answers to `org:cli-status`: whether `sf` answers, and how many orgs it holds. */
interface CliStatusPayload {
  available: boolean;
  orgCount: number;
}

/** What the host answers to `org:open-in-browser`: what the browser did. */
type OrgOpenOutcome = { status: 'opened' } | { status: 'error'; message: string };

/**
 * Above this many orgs the list gets a filter box. Below it every card is
 * on screen at once and a search field would only add noise.
 */
const SEARCH_THRESHOLD = 5;

/** Auth method card definition. */
interface AuthMethodCard {
  method: AuthMethod;
  icon: React.ReactNode;
  labelKey: string;
  descKey: string;
  needsForm: boolean;
  /**
   * Behind "More methods": JWT and the device flow need a connected app of the
   * user's own, and sat at the weight of the two that need nothing.
   */
  more?: boolean;
}

/** Available auth methods shown in the banner. */
const AUTH_METHODS: AuthMethodCard[] = [
  {
    method: 'sfdx_import',
    icon: <Download className="w-4 h-4" />,
    labelKey: 'auth.sfdxImport',
    descKey: 'auth.sfdxImportDesc',
    needsForm: false,
  },
  {
    method: 'oauth_web',
    icon: <Globe className="w-4 h-4" />,
    labelKey: 'auth.oauthWeb',
    descKey: 'auth.oauthWebDesc',
    needsForm: true,
  },
  {
    method: 'usernamePassword',
    icon: <UserCircle className="w-4 h-4" />,
    labelKey: 'auth.usernamePassword',
    descKey: 'auth.usernamePasswordDesc',
    needsForm: true,
  },
  {
    method: 'jwt',
    icon: <Key className="w-4 h-4" />,
    labelKey: 'auth.jwt',
    descKey: 'auth.jwtDesc',
    needsForm: true,
    more: true,
  },
  {
    method: 'oauth_device',
    icon: <Smartphone className="w-4 h-4" />,
    labelKey: 'auth.oauthDevice',
    descKey: 'auth.oauthDeviceDesc',
    needsForm: true,
    more: true,
  },
];

/** Production first: it is where a mistake costs most, so it is never below the fold. */
const ORG_TYPE_RANK: Record<SalesforceOrg['orgType'], number> = {
  Production: 0,
  Sandbox: 1,
  Developer: 2,
  Scratch: 3,
};

/** Within one type, usable orgs before those that need a reconnect. */
const ORG_STATUS_RANK: Record<SalesforceOrg['status'], number> = {
  connected: 0,
  refreshing: 1,
  expired: 2,
  error: 3,
};

/** Display order of the org list: type, then status, then alias. */
function compareOrgs(a: SalesforceOrg, b: SalesforceOrg): number {
  return (
    (ORG_TYPE_RANK[a.orgType] ?? 9) - (ORG_TYPE_RANK[b.orgType] ?? 9) ||
    (ORG_STATUS_RANK[a.status] ?? 9) - (ORG_STATUS_RANK[b.status] ?? 9) ||
    a.alias.localeCompare(b.alias)
  );
}

/** Props for ConnectedNextStep. */
interface ConnectedNextStepProps {
  /** The org the connection brought in (an import's first). */
  justConnectedId: string;
  onDismiss: () => void;
}

/**
 * What to do with the org just connected: fill it with demo data, or clone a
 * record into it from another org. Shown after the page's first connection.
 */
const ConnectedNextStep: React.FC<ConnectedNextStepProps> = ({ justConnectedId, onDismiss }) => {
  const { t } = useTranslation();
  const orgs = useOrgStore((s) => s.orgs);
  const navigate = useAppStore((s) => s.navigate);
  const connected = orgs.filter((org) => org.status === 'connected');
  const just = connected.find((org) => org.id === justConnectedId) ?? connected[0];
  if (!just) return null;
  // The org just connected when it is one to fill; an import's other orgs otherwise.
  const fill = canFill(just) ? just : orgToFill(connected, null);
  const name = (org: SalesforceOrg): string => org.alias || org.username;

  return (
    <section
      className="rounded-lg border border-(--sf-border) bg-(--sf-bg-secondary) px-4 py-3 flex flex-col gap-2"
      aria-labelledby="org-connected-next-title"
      data-testid="org-connected-next"
    >
      <div className="flex items-start gap-2">
        <CheckCircle className="w-4 h-4 text-status-success shrink-0 mt-0.5" aria-hidden="true" />
        <h2
          id="org-connected-next-title"
          className="flex-1 text-sm font-semibold text-text-primary"
        >
          {connected.length > 1
            ? t('org.connectedNext.titleMany', { count: connected.length })
            : t('org.connectedNext.title', { alias: name(just) })}
        </h2>
        <button
          type="button"
          className="text-text-secondary hover:text-text-primary transition-colors"
          onClick={onDismiss}
          aria-label={t('common.close')}
          data-testid="org-connected-next-dismiss"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="flex flex-wrap gap-2">
        {fill && (
          <Button
            onClick={() => navigate('seed', { seedMode: 'quick-seed', targetOrgId: fill.id })}
            data-testid="org-connected-next-fill"
          >
            {t('org.connectedNext.fill', { alias: name(fill) })}
          </Button>
        )}
        <Button
          variant={fill ? 'secondary' : 'primary'}
          onClick={() => navigate('forge')}
          data-testid="org-connected-next-clone"
        >
          {t('org.connectedNext.clone')}
        </Button>
      </div>
    </section>
  );
};

/** OrgManager page — list, connect, edit, disconnect orgs. */
export const OrgManagerPage: React.FC = () => {
  const { t } = useTranslation();
  const orgs = useOrgStore((s) => s.orgs);
  const connectedOrgs = orgs.filter((o) => o.status === 'connected');
  const selectedOrgId = useOrgStore((s) => s.selectedOrgId);
  // Selection propagates: local store for this panel + `org:select` through
  // the broker so the extension updates the status bar and broadcasts
  // `org:selected` to the sidebar and every other panel.
  const selectOrgLocal = useOrgStore((s) => s.selectOrg);
  const selectOrg = useCallback(
    (id: string | null) => {
      selectOrgLocal(id);
      if (id) sendBridgeMessage('org:select', { orgId: id });
    },
    [selectOrgLocal],
  );
  const removeOrg = useOrgStore((s) => s.removeOrg);

  const [activeMethod, setActiveMethod] = useState<AuthMethod | null>(null);
  /** Whether JWT and the device flow are shown, folded under "More methods" until asked for. */
  const [moreMethodsOpen, setMoreMethodsOpen] = useState(false);
  /**
   * The org the first connection of this page brought in, for the card that
   * says what to do with it; null once dismissed or before. The form used to
   * collapse on success, and that was all: a list of one card, no next step.
   */
  const [justConnectedId, setJustConnectedId] = useState<string | null>(null);
  /** Whether no org was connected when the attempt under way started. */
  const firstConnectRef = useRef(false);
  const [search, setSearch] = useState('');
  const [editingOrg, setEditingOrg] = useState<SalesforceOrg | null>(null);
  const [orgPendingDisconnect, setOrgPendingDisconnect] = useState<SalesforceOrg | null>(null);
  /** Whether the org's backups on this machine go with it: asked in the dialog, off by default. */
  const [deleteBackupsWithOrg, setDeleteBackupsWithOrg] = useState(false);

  // Inline form state
  const [alias, setAlias] = useState('');
  const [loginUrl, setLoginUrl] = useState('https://login.salesforce.com');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [securityToken, setSecurityToken] = useState('');
  const [clientId, setClientId] = useState('');
  const [jwtKeyFile, setJwtKeyFile] = useState('');
  // The code of a device sign-in, kept with the request it answers so a code
  // from an earlier attempt is never shown for the current one.
  const [deviceCode, setDeviceCode] = useState<{ requestId: string; code: OrgDeviceCode } | null>(
    null,
  );
  const submitRef = useRef<HTMLButtonElement>(null);

  const loginUrlOptions = [
    { value: 'https://login.salesforce.com', label: t('auth.loginProduction') },
    { value: 'https://test.salesforce.com', label: t('auth.loginSandbox') },
  ];

  // Fetch org list on mount via bridge
  const orgListQuery = useBridgeQuery<OrgListPayload>('org:list');

  // Whether the CLI answers, asked as the page opens: two of the ways to
  // connect run on it, and its absence was found only after a click.
  const cliStatusQuery = useBridgeQuery<CliStatusPayload>('org:cli-status');
  const cliMissing = cliStatusQuery.data?.available === false;
  const cliHoldsNoOrg =
    cliStatusQuery.data?.available === true && cliStatusQuery.data.orgCount === 0;

  useEffect(() => {
    if (orgListQuery.data) {
      useOrgStore.getState().setOrgs(orgListQuery.data.orgs);
    }
  }, [orgListQuery.data]);

  const connectMutation = useBridgeMutation<OrgStatusPayload>('org:connect', {
    responseType: 'org:statusChanged',
    // `oauth_web` shells out to `sf org login web`, which SfdxBridge allows
    // 120 s for the browser round trip. The 30 s default expired while the
    // user was still logging in: the form collapsed mid-login and the typed
    // credentials were wiped.
    timeoutMs: 180_000,
  });

  // A device sign-in waits for the user to approve a code in the browser, for
  // up to ten minutes: far past what any other method may take before the
  // page should call it lost, so it runs on a request of its own.
  const deviceMutation = useBridgeMutation<OrgStatusPayload>('org:connect', {
    responseType: 'org:statusChanged',
    timeoutMs: DEVICE_SIGN_IN_TIMEOUT_MS,
  });

  const disconnectMutation = useBridgeMutation<OrgStatusPayload>('org:disconnect', {
    responseType: 'org:statusChanged',
  });

  // The host saves an edit to the org registry and answers with the saved
  // list. The card changes only then: an edit applied to this panel's copy
  // alone was put back by the next org list and lost on reload.
  const updateMutation = useBridgeMutation<OrgListPayload>('org:update', {
    responseType: 'org:list:response',
  });

  useEffect(() => {
    if (updateMutation.data) {
      useOrgStore.getState().setOrgs(updateMutation.data.orgs);
    }
  }, [updateMutation.data]);

  // VS Code may ask before opening an external site, and the host answers
  // once the user has decided: the 30 s default would call a page that did
  // open a failure.
  const openMutation = useBridgeMutation<OrgOpenOutcome>('org:open-in-browser', {
    timeoutMs: 300_000,
  });
  const [openingOrg, setOpeningOrg] = useState<SalesforceOrg | null>(null);

  const isConnecting = connectMutation.loading || deviceMutation.loading;
  const connectError = connectMutation.error ?? deviceMutation.error;
  const connectHint = connectError
    ? bannerHintOf(
        connectError,
        connectMutation.error ? connectMutation.errorCode : deviceMutation.errorCode,
      )
    : null;

  const connectMutate = connectMutation.mutate;
  const connectReset = connectMutation.reset;
  const deviceMutate = deviceMutation.mutate;
  const deviceReset = deviceMutation.reset;
  const deviceLoading = deviceMutation.loading;
  const deviceRequestId = deviceMutation.requestId;

  /**
   * End the device sign-in on this page: the host is told to stop waiting
   * when one is still in flight, and the request's state is cleared either way.
   */
  const stopDeviceSignIn = useCallback(() => {
    if (deviceLoading && deviceRequestId) {
      sendBridgeMessage('org:connect:cancel', { requestId: deviceRequestId });
    }
    deviceReset();
    setDeviceCode(null);
  }, [deviceLoading, deviceRequestId, deviceReset]);

  const handleConnect = useCallback(
    (payload: ConnectOrgPayload) => {
      const message = {
        orgId: '',
        authMethod: payload.authMethod,
        alias: payload.alias,
        loginUrl: payload.loginUrl,
        username: payload.username,
        password: payload.password,
        securityToken: payload.securityToken,
        clientId: payload.clientId,
        jwtKeyFile: payload.jwtKeyFile,
      };
      firstConnectRef.current = useOrgStore
        .getState()
        .orgs.every((org) => org.status !== 'connected');
      setJustConnectedId(null);
      // The request that is not starting is cleared, so an earlier failure of
      // one method never sits in the banner above an attempt with the other —
      // and a device sign-in still waiting (the empty state and Reconnect can
      // start an import meanwhile) is stopped rather than left to finish unseen.
      if (payload.authMethod === 'oauth_device') {
        connectReset();
        deviceMutate(message);
      } else {
        stopDeviceSignIn();
        connectMutate(message);
      }
    },
    [connectMutate, connectReset, deviceMutate, stopDeviceSignIn],
  );

  // Collapse inline form when the connect mutation completes *successfully*.
  // On failure the form used to close silently: the typed credentials were
  // wiped and the user was left believing the org had been added. Keep the
  // form and its input open so the error can be read and the attempt retried.
  const connectLoading = connectMutation.loading;
  const connectFailure = connectMutation.error;
  const connectedOrgId = connectMutation.data?.orgId;
  const prevConnecting = useRef(connectLoading);
  useEffect(() => {
    if (prevConnecting.current && !connectLoading && !connectFailure) {
      setActiveMethod(null);
      resetForm();
      if (firstConnectRef.current && connectedOrgId) setJustConnectedId(connectedOrgId);
    }
    prevConnecting.current = connectLoading;
  }, [connectLoading, connectFailure, connectedOrgId]);

  // A device sign-in collapses the form on its answer alone: a cancelled one
  // also stops loading without an error, and must leave the form open.
  const deviceSignedIn = deviceMutation.data;
  useEffect(() => {
    if (deviceSignedIn) {
      setActiveMethod(null);
      resetForm();
      if (firstConnectRef.current) setJustConnectedId(deviceSignedIn.orgId);
    }
  }, [deviceSignedIn]);

  // An import that found no org in the CLI opens the browser sign-in, the
  // way that needs none: it answered with a terminal command, on the page
  // whose OAuth (Web) button runs it.
  const noCliOrgs = connectMutation.errorCode === 'NO_CLI_ORGS';
  useEffect(() => {
    if (noCliOrgs) setActiveMethod('oauth_web');
  }, [noCliOrgs]);

  useMessageListener('org:device-code', (message: BaseMessage) => {
    if (!deviceRequestId || message.correlationId !== deviceRequestId) return;
    const code = readDeviceCode((message as BaseMessage & { payload?: unknown }).payload);
    if (code) setDeviceCode({ requestId: deviceRequestId, code });
  });
  const shownDeviceCode =
    deviceLoading && deviceCode !== null && deviceCode.requestId === deviceRequestId
      ? deviceCode.code
      : null;

  // The code panel replaces the form, the button with focus included; when it
  // goes — cancelled, refused or expired — focus returns to the button that
  // starts a new attempt instead of falling to the page.
  const hadDeviceCode = useRef(false);
  useEffect(() => {
    if (hadDeviceCode.current && shownDeviceCode === null) submitRef.current?.focus();
    hadDeviceCode.current = shownDeviceCode !== null;
  }, [shownDeviceCode]);

  const resetForm = (): void => {
    setAlias('');
    setLoginUrl('https://login.salesforce.com');
    setUsername('');
    setPassword('');
    setSecurityToken('');
    setClientId('');
    setJwtKeyFile('');
  };

  /** Close the method panel, stopping a device sign-in still waiting in it. */
  const closeMethodPanel = (): void => {
    if (deviceLoading) stopDeviceSignIn();
    setActiveMethod(null);
    resetForm();
  };

  /** Handle clicking an auth method button. */
  const handleMethodClick = useCallback(
    (card: AuthMethodCard) => {
      if (card.method === activeMethod) {
        setActiveMethod(null);
        resetForm();
        return;
      }
      resetForm();

      // Methods that trigger immediately
      if (card.method === 'sfdx_import') {
        handleConnect({ alias: '', authMethod: 'sfdx_import', loginUrl: '' });
        return;
      }

      setActiveMethod(card.method);
    },
    [activeMethod, handleConnect],
  );

  /** Submit the inline form. */
  const handleInlineSubmit = useCallback(() => {
    if (!activeMethod) return;
    handleConnect({
      alias: alias.trim(),
      authMethod: activeMethod,
      loginUrl,
      ...(activeMethod === 'usernamePassword'
        ? { username: username.trim(), password, securityToken: securityToken.trim() }
        : {}),
      ...(activeMethod === 'jwt'
        ? { username: username.trim(), clientId: clientId.trim(), jwtKeyFile: jwtKeyFile.trim() }
        : {}),
      ...(activeMethod === 'oauth_device' ? { clientId: clientId.trim() } : {}),
    });
  }, [
    activeMethod,
    alias,
    loginUrl,
    username,
    password,
    securityToken,
    clientId,
    jwtKeyFile,
    handleConnect,
  ]);

  const hasAlias = alias.trim().length > 0;
  // `sf org login web` names the org itself when given no alias: the alias is
  // optional there, and the browser login could not start until one was typed.
  const canSubmit =
    activeMethod === 'oauth_web'
      ? true
      : activeMethod === 'usernamePassword'
        ? hasAlias && username.trim().length > 0 && password.length > 0
        : activeMethod === 'jwt'
          ? hasAlias &&
            username.trim().length > 0 &&
            clientId.trim().length > 0 &&
            jwtKeyFile.trim().length > 0
          : activeMethod === 'oauth_device'
            ? hasAlias && clientId.trim().length > 0
            : false;

  const submitLabel =
    activeMethod === 'oauth_web'
      ? t('auth.openBrowser')
      : activeMethod === 'oauth_device'
        ? t('auth.deviceStart')
        : t('org.connect');

  // An expired or failed org used to show its badge and nothing else. Reconnect
  // replays the method it was added with: a CLI import runs again, a browser or
  // password login reopens its form with the alias — and the username — filled
  // in. The password is never kept, so it is typed again.
  const handleReconnect = useCallback(
    (org: SalesforceOrg) => {
      if (org.authMethod === 'sfdx_import') {
        handleConnect({ alias: '', authMethod: 'sfdx_import', loginUrl: '' });
        return;
      }
      // The form it reopens replaces a device code still waiting, if any.
      if (deviceLoading) stopDeviceSignIn();
      resetForm();
      setActiveMethod(org.authMethod);
      setAlias(org.alias);
      setLoginUrl(
        org.orgType === 'Sandbox' || org.orgType === 'Scratch'
          ? 'https://test.salesforce.com'
          : 'https://login.salesforce.com',
      );
      if (org.authMethod === 'usernamePassword') setUsername(org.username);
    },
    [handleConnect, deviceLoading, stopDeviceSignIn],
  );

  // What this page was opened to start: an import from the CLI or the browser
  // sign-in, from the launcher's first card, or the Reconnect of an org whose
  // session expired during a run. Read from the store, as it arrives after a
  // new panel's first render, and cleared once done.
  const navigationIntent = useAppStore((s) => s.navigationIntent);
  const clearNavigationIntent = useAppStore((s) => s.clearNavigationIntent);
  useEffect(() => {
    if (navigationIntent?.route !== 'orgs') return;
    if (navigationIntent.orgAction === 'import-cli') {
      clearNavigationIntent();
      handleConnect({ alias: '', authMethod: 'sfdx_import', loginUrl: '' });
    } else if (navigationIntent.orgAction === 'login-web') {
      clearNavigationIntent();
      setActiveMethod('oauth_web');
    } else if (navigationIntent.reconnectOrgId) {
      const org = orgs.find((candidate) => candidate.id === navigationIntent.reconnectOrgId);
      if (!org) return;
      clearNavigationIntent();
      handleReconnect(org);
    }
  }, [navigationIntent, clearNavigationIntent, handleConnect, handleReconnect, orgs]);

  const handleEdit = useCallback((org: SalesforceOrg) => {
    setEditingOrg(org);
  }, []);

  const updateMutate = updateMutation.mutate;
  const handleSave = useCallback(
    (orgId: string, payload: OrgEditPayload) => {
      updateMutate({ orgId, alias: payload.alias, color: payload.color, tags: payload.tags });
      setEditingOrg(null);
    },
    [updateMutate],
  );

  // The card names the org and nothing else: the host opens the org's own
  // stored instance URL, never an address from this page.
  const openMutate = openMutation.mutate;
  const handleOpenInBrowser = useCallback(
    (org: SalesforceOrg) => {
      setOpeningOrg(org);
      openMutate({ orgId: org.id });
    },
    [openMutate],
  );
  // A refusal answers on `org:error` with a code, a browser that did not open
  // answers `status: 'error'`; the host words both in English, for its log.
  const openOutcome = openMutation.data;
  const openAlias = openingOrg?.alias || openingOrg?.username || '';
  const openError =
    openMutation.errorCode === 'INVALID_INSTANCE_URL'
      ? t('org.openRefusedUrl', { alias: openAlias })
      : openMutation.errorCode === 'ORG_NOT_FOUND'
        ? t('org.openNotFound', { alias: openAlias })
        : (openMutation.error ??
          (openOutcome?.status === 'error'
            ? t('org.openFailed', { alias: openAlias, reason: openOutcome.message })
            : null));

  const disconnectMutate = disconnectMutation.mutate;

  // Disconnect drops the registry entry host-side, so the alias, tags, colour
  // and safety tier typed here are gone for good — a re-connect starts from
  // defaults. Too destructive for a bare click, hence the typed confirmation.
  const handleDisconnect = useCallback(
    (orgId: string) => {
      setDeleteBackupsWithOrg(false);
      setOrgPendingDisconnect(orgs.find((o) => o.id === orgId) ?? null);
    },
    [orgs],
  );

  const confirmDisconnect = useCallback(() => {
    if (!orgPendingDisconnect) return;
    // Its backups first, while the request still names an org the page knows:
    // they stayed on this machine, in clear, once nothing listed them.
    if (deleteBackupsWithOrg) {
      sendBridgeMessage('backup:delete', { orgId: orgPendingDisconnect.id });
    }
    disconnectMutate({ orgId: orgPendingDisconnect.id });
    removeOrg(orgPendingDisconnect.id);
    setOrgPendingDisconnect(null);
  }, [orgPendingDisconnect, deleteBackupsWithOrg, disconnectMutate, removeOrg]);

  // Filtering only appears once the list stops fitting on screen. The query is
  // ignored while the field is hidden, so disconnecting down to a short list
  // can never leave cards filtered out by a box the user can no longer see.
  const showSearch = orgs.length > SEARCH_THRESHOLD;
  const searchTerm = showSearch ? search.trim().toLowerCase() : '';
  const visibleOrgs = (
    searchTerm
      ? orgs.filter((o) =>
          [o.alias, o.username, o.instanceUrl, o.orgType, o.tags.join(' ')].some((field) =>
            field.toLowerCase().includes(searchTerm),
          ),
        )
      : [...orgs]
  ).sort(compareOrgs);

  // Fetching the registry, or importing from the CLI, used to paint nothing at
  // all: `orgs` is still empty, so the grid rendered zero cards and the empty
  // state was suppressed. A first-time user saw a blank panel and no way to
  // tell the import from a dead extension. A device sign-in waiting for its
  // approval is not a load: the panel above already says what it waits for.
  const isLoadingOrgs = (orgListQuery.loading || connectMutation.loading) && orgs.length === 0;

  return (
    <div className="flex flex-col gap-4" data-testid="org-manager-page">
      {/* Banner with integrated auth methods */}
      <div
        className="rounded-lg border border-(--sf-border) bg-(--sf-bg-primary) overflow-hidden"
        data-testid="org-connect-banner"
      >
        {/* Header row */}
        <div className="flex items-center gap-3 px-4 py-3">
          <Plug className="w-5 h-5 text-text-secondary shrink-0" />
          <div className="flex-1 min-w-0">
            <h1 className="text-sm font-semibold text-text-primary">{t('org.title')}</h1>
            <p className="text-xs text-text-secondary mt-0.5">
              {orgs.length > 0
                ? t('org.bannerConnected', { count: connectedOrgs.length, total: orgs.length })
                : t('org.bannerEmpty')}
            </p>
          </div>
        </div>

        {/* Auth method buttons row */}
        <div className="flex items-center gap-2 px-4 pb-3 flex-wrap" data-testid="org-auth-methods">
          {AUTH_METHODS.filter(
            (card) => !card.more || moreMethodsOpen || activeMethod === card.method,
          ).map((card) => {
            const isActive = activeMethod === card.method;
            return (
              <button
                key={card.method}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium',
                  'border transition-all',
                  isActive
                    ? 'bg-(--sf-button-bg) text-(--sf-button-fg) border-(--sf-button-bg)'
                    : 'bg-(--sf-button-secondary-bg) text-(--sf-button-secondary-fg) border-transparent hover:bg-(--sf-button-secondary-hover)',
                  'disabled:pointer-events-none disabled:opacity-60',
                )}
                onClick={() => handleMethodClick(card)}
                disabled={isConnecting}
                title={t(card.descKey)}
                data-testid={`org-auth-${card.method}`}
              >
                {card.method === 'sfdx_import' && connectMutation.loading ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  card.icon
                )}
                <span>{t(card.labelKey)}</span>
              </button>
            );
          })}
          <button
            type="button"
            className="flex items-center gap-1 px-2 py-1.5 rounded-md text-xs text-(--sf-text-link) hover:underline"
            onClick={() => setMoreMethodsOpen((open) => !open)}
            aria-expanded={moreMethodsOpen}
            data-testid="org-auth-more"
          >
            <ChevronDown
              className={cn('w-3.5 h-3.5 transition-transform', moreMethodsOpen && 'rotate-180')}
              aria-hidden="true"
            />
            {t('org.moreMethods')}
          </button>
        </div>

        {cliMissing && (
          <div
            className="border-t border-(--sf-border) bg-(--sf-bg-secondary) px-4 py-2 text-xs text-status-warning"
            data-testid="org-cli-missing"
          >
            {t('org.cliMissing')}{' '}
            <a
              href={SF_CLI_INSTALL_URL}
              target="_blank"
              rel="noreferrer"
              className="underline text-(--sf-text-link)"
            >
              {t('org.installCli')}
            </a>
          </div>
        )}
        {cliHoldsNoOrg && !noCliOrgs && orgs.length === 0 && (
          <div
            className="border-t border-(--sf-border) bg-(--sf-bg-secondary) px-4 py-2 text-xs text-text-secondary"
            data-testid="org-cli-empty"
          >
            {t('errors.noCliOrgs.explanation')} {t('errors.noCliOrgs.action')}
          </div>
        )}

        {updateMutation.error && (
          <div
            className="border-t border-(--sf-border) bg-(--sf-bg-secondary) px-4 py-2 text-xs text-status-error"
            role="alert"
            data-testid="org-update-error"
          >
            {updateMutation.error}
          </div>
        )}

        {openError && (
          <div
            className="border-t border-(--sf-border) bg-(--sf-bg-secondary) px-4 py-2 text-xs text-status-error"
            role="alert"
            data-testid="org-open-error"
          >
            {openError}
          </div>
        )}

        {/* Connect failure — surfaced in the banner so it is visible for the
            form-less methods (sfdx_import) too. `mutate` clears it on retry. */}
        {connectError && (
          <div
            className="border-t border-(--sf-border) bg-(--sf-bg-secondary) px-4 py-2 text-xs text-status-error"
            role="alert"
            data-testid="org-connect-error"
          >
            <span className="font-semibold">{t('org.status_error')}</span> — {connectError}
            {/* The banner is the only place this failure survives once the
                toast is gone, and the CLI is what two of the three working
                auth methods run on. VS Code opens the link in the browser. */}
            {connectError.includes(SF_CLI_MISSING_MESSAGE) && (
              <>
                {' '}
                <a
                  href={SF_CLI_INSTALL_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="underline text-(--sf-text-link)"
                  data-testid="org-connect-error-cli-install"
                >
                  {t('org.installCli')}
                </a>
              </>
            )}
            {/* An org whose edition has no API, or a user without API
                Enabled, is refused as soon as SandForge calls it: said by
                the error catalogue, with what to do. */}
            {connectHint && <ErrorExplanation hint={connectHint} className="mt-1.5" />}
          </div>
        )}

        {/* Inline form — expands when a method with form is selected */}
        {activeMethod && activeMethod !== 'sfdx_import' && (
          <div
            className="border-t border-(--sf-border) bg-(--sf-bg-secondary) px-4 py-3"
            data-testid="org-inline-form"
          >
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-semibold text-text-primary">
                {t(AUTH_METHODS.find((m) => m.method === activeMethod)?.labelKey ?? '')}
              </span>
              <button
                type="button"
                className="text-text-secondary hover:text-text-primary transition-colors"
                onClick={closeMethodPanel}
                aria-label={t('common.close')}
                data-testid="org-inline-close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {shownDeviceCode ? (
              <DeviceCodePanel code={shownDeviceCode} onCancel={stopDeviceSignIn} />
            ) : (
              <div className="grid gap-3 max-w-lg">
                {activeMethod === 'jwt' && (
                  <p className="text-xs text-text-secondary">{t('auth.jwtHelp')}</p>
                )}
                {activeMethod === 'oauth_device' && (
                  <p className="text-xs text-text-secondary">{t('auth.deviceHelp')}</p>
                )}

                <Select
                  label={t('auth.loginUrl')}
                  options={loginUrlOptions}
                  value={loginUrl}
                  onChange={(e) => setLoginUrl(e.target.value)}
                />

                <Input
                  label={t('org.alias')}
                  value={alias}
                  onChange={(e) => setAlias(e.target.value)}
                  placeholder={t('org.aliasPlaceholder')}
                  hint={activeMethod === 'oauth_web' ? t('org.aliasOptionalHint') : undefined}
                  data-testid="inline-alias-input"
                />

                {(activeMethod === 'usernamePassword' || activeMethod === 'jwt') && (
                  <Input
                    label={t('auth.username')}
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder={t('auth.usernamePlaceholder')}
                    data-testid="inline-username-input"
                  />
                )}

                {activeMethod === 'usernamePassword' && (
                  <>
                    <Input
                      label={t('auth.password')}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      type="password"
                      data-testid="inline-password-input"
                    />
                    <Input
                      label={t('auth.securityToken')}
                      value={securityToken}
                      onChange={(e) => setSecurityToken(e.target.value)}
                      placeholder={t('auth.securityTokenHint')}
                      data-testid="inline-token-input"
                    />
                  </>
                )}

                {(activeMethod === 'jwt' || activeMethod === 'oauth_device') && (
                  <Input
                    label={t('auth.clientId')}
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    data-testid="inline-client-id-input"
                  />
                )}

                {activeMethod === 'jwt' && (
                  <Input
                    label={t('auth.jwtKeyFile')}
                    value={jwtKeyFile}
                    onChange={(e) => setJwtKeyFile(e.target.value)}
                    placeholder={t('auth.jwtKeyFilePlaceholder')}
                    hint={t('auth.jwtKeyFileHint')}
                    autoComplete="off"
                    spellCheck={false}
                    data-testid="inline-key-file-input"
                  />
                )}

                <div className="flex items-center gap-2 pt-1">
                  <Button
                    ref={submitRef}
                    onClick={handleInlineSubmit}
                    loading={isConnecting}
                    disabled={!canSubmit}
                    data-testid="org-inline-connect"
                  >
                    {submitLabel}
                  </Button>
                  <Button variant="ghost" onClick={closeMethodPanel}>
                    {t('common.cancel')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {orgListQuery.error && (
        <div className="text-status-error" data-testid="org-list-error">
          {orgListQuery.error}
        </div>
      )}

      {justConnectedId && (
        <ConnectedNextStep
          justConnectedId={justConnectedId}
          onDismiss={() => setJustConnectedId(null)}
        />
      )}

      {isLoadingOrgs ? (
        <div
          className="flex items-center justify-center gap-2 py-12 text-xs text-text-secondary"
          role="status"
          aria-live="polite"
          data-testid="org-list-loading"
        >
          <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
          <span>{t('common.loading')}</span>
        </div>
      ) : orgs.length === 0 ? (
        // The empty state repeated the instruction "import from Salesforce CLI"
        // without offering it: the button lived in the banner, one of five.
        // With a CLI that holds no org, the import could only fail: the
        // browser sign-in is offered instead.
        cliHoldsNoOrg ? (
          <EmptyState
            title={t('org.noOrgs')}
            description={t('org.bannerEmpty')}
            actionLabel={t('auth.oauthWeb')}
            onAction={() => setActiveMethod('oauth_web')}
          />
        ) : (
          <EmptyState
            title={t('org.noOrgs')}
            description={t('org.bannerEmpty')}
            actionLabel={t('auth.sfdxImport')}
            onAction={() => handleConnect({ alias: '', authMethod: 'sfdx_import', loginUrl: '' })}
          />
        )
      ) : (
        <div className="flex flex-col gap-3">
          {showSearch && (
            <Input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('common.search')}
              aria-label={t('common.search')}
              data-testid="org-search-input"
            />
          )}

          {visibleOrgs.length === 0 ? (
            <p
              className="py-8 text-center text-xs text-text-secondary"
              data-testid="org-search-empty"
            >
              {t('common.noData')}
            </p>
          ) : (
            <div className="grid gap-3">
              {visibleOrgs.map((org) => (
                <OrgCard
                  key={org.id}
                  org={org}
                  selected={org.id === selectedOrgId}
                  onSelect={selectOrg}
                  onEdit={handleEdit}
                  onDisconnect={handleDisconnect}
                  onReconnect={handleReconnect}
                  onOpenInBrowser={handleOpenInBrowser}
                />
              ))}
            </div>
          )}
        </div>
      )}

      <OrgEditDialog
        org={editingOrg}
        open={editingOrg !== null}
        onClose={() => setEditingOrg(null)}
        onSave={handleSave}
      />

      <DangerConfirm
        open={orgPendingDisconnect !== null}
        onClose={() => setOrgPendingDisconnect(null)}
        onConfirm={confirmDisconnect}
        title={t('org.disconnect')}
        description={t('org.disconnectConfirm', {
          alias: orgPendingDisconnect?.alias || orgPendingDisconnect?.username || '',
        })}
        confirmText={t('org.disconnect')}
      >
        {orgPendingDisconnect && (
          <DisconnectBackups
            orgId={orgPendingDisconnect.id}
            checked={deleteBackupsWithOrg}
            onChange={setDeleteBackupsWithOrg}
          />
        )}
      </DangerConfirm>
    </div>
  );
};
