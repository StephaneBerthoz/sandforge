import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  BaseMessage,
  BridgeErrorMessage,
  SalesforceOrg,
  AIStatusResponse,
} from '@sandforge/shared';
import { useSendMessage, useMessageListener } from '../hooks/useMessageBus';
import { useRecentOpsFeed } from '../hooks/useRecentOpsFeed';
import { useOrgStore } from '../stores/useOrgStore';
import { useAppStore } from '../stores/useAppStore';
import { useNotificationStore } from '../stores/useNotificationStore';
import type { NotificationAction } from '../stores/useNotificationStore';
import { useGrappeStore } from '../stores/useGrappeStore';
import { importLanguageFromSettings } from '../i18n';
import { buildMessage } from './messageHelpers';
import { isRequestFromHere } from './sendBridgeMessage';

/**
 * How each reason the broker drops a request for is told. The toast used to
 * read "Bridge error" over the broker's own code — "invalid-payload: payload:
 * Expected object" — in English whatever the language. What was wrong in
 * detail stays in the SandForge output channel, where the broker writes it.
 */
const DROP_REASON_KEYS: Readonly<Record<string, string>> = {
  'invalid-payload': 'bridge.dropped.unreadable',
  'rate-limited': 'bridge.dropped.rateLimited',
  'unhandled-type': 'bridge.dropped.unhandled',
};

/** Props for BridgeProvider. */
export interface BridgeProviderProps {
  children: React.ReactNode;
}

/**
 * React wrapper that initializes the extension<->webview bridge.
 * On mount, sends initial requests (org:list, settings:get).
 * Listens for state:sync, org:list:response, org:statusChanged,
 * notification, and operation lifecycle messages.
 */
export const BridgeProvider: React.FC<BridgeProviderProps> = ({ children }) => {
  const { t } = useTranslation();
  const sendMessage = useSendMessage();
  const initialSent = useRef(false);

  // Feed the recent-operations store from operation lifecycle messages
  useRecentOpsFeed();

  // Send initial requests on mount
  useEffect(() => {
    if (initialSent.current) {
      return;
    }
    initialSent.current = true;

    sendMessage(buildMessage('org:list'));
    sendMessage(buildMessage('settings:get'));
    sendMessage(buildMessage('ai:status'));
  }, [sendMessage]);

  // Listen for org:list:response → setOrgs + auto-select first connected org
  useMessageListener<BaseMessage & { payload: { orgs: SalesforceOrg[] } }>(
    'org:list:response',
    (msg) => {
      useOrgStore.getState().setOrgs(msg.payload.orgs);

      const state = useOrgStore.getState();

      // Reconcile a stale selection: the webview persists selectedOrgId across
      // reloads, but the org may be gone from the extension config (config
      // reset, org removed, new profile). A stale id makes every module query
      // an org that no longer exists.
      if (state.selectedOrgId && !msg.payload.orgs.some((o) => o.id === state.selectedOrgId)) {
        state.selectOrg(null);
      }

      // Auto-select first connected org when none selected
      const after = useOrgStore.getState();
      if (!after.selectedOrgId && msg.payload.orgs.length > 0) {
        const connected = msg.payload.orgs.filter((o) => o.status === 'connected');
        if (connected.length > 0) {
          after.selectOrg(connected[0].id);
        }
      }
    },
  );

  // Listen for state:sync → update orgs + extensionReady + selected org
  useMessageListener<
    BaseMessage & {
      payload: {
        orgs?: SalesforceOrg[];
        extensionReady?: boolean;
        selectedOrgId?: string | null;
      };
    }
  >('state:sync', (msg) => {
    if (msg.payload.orgs) {
      useOrgStore.getState().setOrgs(msg.payload.orgs as SalesforceOrg[]);
      useOrgStore.getState().setConnecting(false);
    }
    if (msg.payload.extensionReady !== undefined) {
      useAppStore.getState().setExtensionReady(msg.payload.extensionReady);
    }
    // Adopt the extension-side selection only when this document has none of
    // its own — late-opened panels hydrate with the global pick; live changes
    // travel via org:selected broadcasts.
    if (msg.payload.selectedOrgId != null) {
      const store = useOrgStore.getState();
      if (store.selectedOrgId === null) {
        store.selectOrg(msg.payload.selectedOrgId);
      }
    }
  });

  // Listen for org:statusChanged → updateOrg
  useMessageListener<BaseMessage & { payload: { orgId: string; status: string } }>(
    'org:statusChanged',
    (msg) => {
      useOrgStore.getState().updateOrg(msg.payload.orgId, {
        status: msg.payload.status as SalesforceOrg['status'],
      });
      useOrgStore.getState().setConnecting(false);
    },
  );

  // The extension says when VS Code hides or shows this panel.
  useMessageListener<BaseMessage & { payload: { visible: boolean } }>('panel:visibility', (msg) => {
    useAppStore.getState().setPanelVisible(msg.payload.visible);
  });

  // Listen for org:selected (from sidebar) → selectOrg
  useMessageListener<BaseMessage & { payload: { orgId: string } }>('org:selected', (msg) => {
    useOrgStore.getState().selectOrg(msg.payload.orgId);
  });

  // Listen for notifications → addNotification
  useMessageListener<
    BaseMessage & {
      payload: {
        level: 'info' | 'success' | 'warning' | 'error';
        title: string;
        message: string;
        autoDismissMs?: number;
        actions?: NotificationAction[];
      };
    }
  >('notification', (msg) => {
    useNotificationStore.getState().addNotification({
      level: msg.payload.level,
      title: msg.payload.title,
      message: msg.payload.message,
      autoDismissMs: msg.payload.autoDismissMs,
      // Dropped until now: a host notification could carry buttons and the
      // toast rendered none of them.
      actions: msg.payload.actions,
    });
    if (msg.payload.level === 'error' || msg.payload.level === 'success') {
      useOrgStore.getState().setConnecting(false);
    }
  });

  // Listen for bridge:error → surface the drop.
  // The broker replies on this channel when an inbound envelope fails Zod
  // validation, and then discards the message: no handler runs, no domain
  // error comes back, and the sender only learns about it 30 s later as a
  // generic timeout. A rejected message has to be visible while it is still
  // attached to the action that caused it.
  //
  // `bridge:error` is broadcast to every open panel. A refusal that carries a
  // correlationId is raised here only when this panel sent that request:
  // another panel's request is not this panel's to report. It is raised even
  // when a request hook is waiting on it, since many screens never render
  // their hook's error. An uncorrelated drop answers no request, so every
  // panel raises it.
  useMessageListener<BridgeErrorMessage>('bridge:error', (msg) => {
    if (msg.correlationId && !isRequestFromHere(msg.correlationId)) return;
    useNotificationStore.getState().addNotification({
      level: 'error',
      title: t('bridge.dropped.title'),
      message: t(DROP_REASON_KEYS[msg.payload.reason] ?? 'bridge.dropped.other'),
    });
  });

  // Listen for operation lifecycle → setLoading
  useMessageListener<BaseMessage>('operation:started', () => {
    useAppStore.getState().setLoading(true);
  });

  useMessageListener<BaseMessage>('operation:completed', () => {
    useAppStore.getState().setLoading(false);
  });

  // `operation:failed` is broadcast to every open panel, and each one mounts
  // this provider — so a panel must not act on the failure beyond its own UI.
  // Asking the assistant from here cost one request, one org error text sent
  // out and one toast per open panel, for a single failed operation. The
  // extension resolves the failure once where it raises it
  // (`sendOperationFailed`), and shows the suggestion once as a VS Code
  // notification: a toast here would repeat it in every open panel.
  useMessageListener<BaseMessage>('operation:failed', () => {
    useAppStore.getState().setLoading(false);
  });

  // Listen for ai:status:response to track AI availability.
  // Extension payload field is `enabled` (see AIStatusResponse in shared) — the
  // earlier `available` read was a silent contract drift that left aiAvailable
  // stuck at false even with a valid API key configured.
  useMessageListener<AIStatusResponse>('ai:status:response', (msg) => {
    useAppStore.getState().setAiAvailable(msg.payload.enabled);
  });

  // Listen for onboarding:show → display welcome overlay
  useMessageListener<BaseMessage>('onboarding:show', () => {
    useAppStore.getState().setShowWelcome(true);
  });

  // One-shot language recovery: the webview state (per-document) may have
  // lost the persisted language while the extension-side settings blob still
  // carries it — adopt the blob value once (see importLanguageFromSettings).
  useMessageListener<BaseMessage & { payload: { settings?: unknown } }>(
    'settings:response',
    (msg) => {
      importLanguageFromSettings(msg.payload?.settings);
    },
  );

  // Listen for whats-new:show → display what's new overlay
  useMessageListener<BaseMessage & { payload: { version: string } }>('whats-new:show', (msg) => {
    useAppStore.getState().setShowWhatsNew(true, msg.payload.version);
  });

  // ─── Grappe (cluster) message listeners ───────────────────────────────────
  useMessageListener<
    BaseMessage & {
      payload: { operationId: string; totalPartitions: number; totalRecords: number };
    }
  >('grappe:started', (msg) => {
    useGrappeStore
      .getState()
      .start(msg.payload.operationId, msg.payload.totalPartitions, msg.payload.totalRecords);
  });

  useMessageListener<
    BaseMessage & { payload: { grappeId: string; percentage: number; processedRecords: number } }
  >('grappe:partitionProgress', (msg) => {
    useGrappeStore
      .getState()
      .updatePartition(msg.payload.grappeId, msg.payload.percentage, msg.payload.processedRecords);
  });

  useMessageListener<
    BaseMessage & { payload: { operationId: string; totalProcessed: number; totalFailed: number } }
  >('grappe:completed', (msg) => {
    useGrappeStore.getState().complete(msg.payload.totalProcessed, msg.payload.totalFailed);
  });

  return <>{children}</>;
};
