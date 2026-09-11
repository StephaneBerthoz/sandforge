import React, { useEffect, useRef } from 'react';
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
import { useGrappeStore } from '../stores/useGrappeStore';
import { importLanguageFromSettings } from '../i18n';
import { buildMessage } from './messageHelpers';

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
      };
    }
  >('notification', (msg) => {
    useNotificationStore.getState().addNotification({
      level: msg.payload.level,
      title: msg.payload.title,
      message: msg.payload.message,
      autoDismissMs: msg.payload.autoDismissMs,
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
  useMessageListener<BridgeErrorMessage>('bridge:error', (msg) => {
    useNotificationStore.getState().addNotification({
      level: 'error',
      title: 'Bridge error',
      message: `${msg.payload.reason}: ${msg.payload.details}`,
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
  // extension now resolves the failure once where it raises it
  // (`sendOperationFailed`) and pushes the answer on the channel below.
  useMessageListener<BaseMessage>('operation:failed', () => {
    useAppStore.getState().setLoading(false);
  });

  // Listen for AI error resolutions → show as notification
  useMessageListener<
    BaseMessage & {
      payload: {
        success: boolean;
        resolution?: { explanation: string; suggestedFix: string; confidence: number };
      };
    }
  >('ai:resolve-error:response', (msg) => {
    if (msg.payload.success && msg.payload.resolution) {
      useNotificationStore.getState().addNotification({
        level: 'info',
        title: 'AI Fix Suggestion',
        message: msg.payload.resolution.suggestedFix,
        autoDismissMs: 15_000,
      });
    }
  });

  // Listen for ai:status:response to track AI availability.
  // Extension payload field is `enabled` (see AIStatusResponse in shared) — the
  // earlier `available` read was a silent contract drift that left aiAvailable
  // stuck at false even with a valid API key configured.
  useMessageListener<AIStatusResponse>('ai:status:response', (msg) => {
    useAppStore.getState().setAiAvailable(msg.payload.enabled);
  });

  // Request connectivity status on mount
  useEffect(() => {
    sendMessage(buildMessage('connectivity:status'));
  }, [sendMessage]);

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
