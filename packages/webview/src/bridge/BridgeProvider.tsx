import React, { useEffect, useRef } from 'react';
import type { BaseMessage, SalesforceOrg, BackPressureLevel } from '@sandforge/shared';
import { useSendMessage, useMessageListener } from '../hooks/useMessageBus';
import { useOrgStore } from '../stores/useOrgStore';
import { useAppStore } from '../stores/useAppStore';
import { useNotificationStore } from '../stores/useNotificationStore';
import { useGrappeStore } from '../stores/useGrappeStore';
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

      // Auto-select first connected org when none selected
      const state = useOrgStore.getState();
      if (!state.selectedOrgId && msg.payload.orgs.length > 0) {
        const connected = msg.payload.orgs.filter((o) => o.status === 'connected');
        if (connected.length > 0) {
          state.selectOrg(connected[0].id);
        }
      }
    },
  );

  // Listen for state:sync → update orgs + extensionReady
  useMessageListener<
    BaseMessage & {
      payload: {
        orgs?: SalesforceOrg[];
        extensionReady?: boolean;
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
  useMessageListener<BaseMessage & { payload: { orgId: string } }>(
    'org:selected',
    (msg) => {
      useOrgStore.getState().selectOrg(msg.payload.orgId);
    },
  );

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

  // Listen for operation lifecycle → setLoading
  useMessageListener<BaseMessage>('operation:started', () => {
    useAppStore.getState().setLoading(true);
  });

  useMessageListener<BaseMessage>('operation:completed', () => {
    useAppStore.getState().setLoading(false);
  });

  useMessageListener<BaseMessage & { payload: { operationId: string; error: string; retryable: boolean } }>(
    'operation:failed',
    (msg) => {
      useAppStore.getState().setLoading(false);

      // Auto-invoke AI error resolver if an operation fails and AI is available
      if (useAppStore.getState().aiAvailable) {
        sendMessage(buildMessage<{ errorMessage: string; module: string; context: Record<string, unknown> }>(
          'ai:resolve-error',
          {
            errorMessage: msg.payload.error,
            module: 'unknown',
            context: { operationId: msg.payload.operationId, retryable: msg.payload.retryable },
          },
        ));
      }
    },
  );

  // Listen for AI error resolution responses → show as notification
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

  // Listen for ai:status:response to track AI availability
  useMessageListener<BaseMessage & { payload: { available: boolean } }>(
    'ai:status:response',
    (msg) => {
      useAppStore.getState().setAiAvailable(msg.payload.available);
    },
  );

  // Request connectivity status on mount
  useEffect(() => {
    sendMessage(buildMessage('connectivity:status'));
  }, [sendMessage]);

  // Listen for onboarding:show → display welcome overlay
  useMessageListener<BaseMessage>('onboarding:show', () => {
    useAppStore.getState().setShowWelcome(true);
  });

  // Listen for whats-new:show → display what's new overlay
  useMessageListener<BaseMessage & { payload: { version: string } }>(
    'whats-new:show',
    (msg) => {
      useAppStore.getState().setShowWhatsNew(true, msg.payload.version);
    },
  );

  // ─── Grappe (cluster) message listeners ───────────────────────────────────
  useMessageListener<
    BaseMessage & { payload: { operationId: string; totalPartitions: number; totalRecords: number } }
  >('grappe:started', (msg) => {
    useGrappeStore.getState().start(
      msg.payload.operationId,
      msg.payload.totalPartitions,
      msg.payload.totalRecords,
    );
  });

  useMessageListener<
    BaseMessage & { payload: { grappeId: string; percentage: number; processedRecords: number } }
  >('grappe:partitionProgress', (msg) => {
    useGrappeStore.getState().updatePartition(
      msg.payload.grappeId,
      msg.payload.percentage,
      msg.payload.processedRecords,
    );
  });

  useMessageListener<
    BaseMessage & { payload: { level: BackPressureLevel; apiPercent: number } }
  >('grappe:backPressure', (msg) => {
    useGrappeStore.getState().updateBackPressure(
      msg.payload.level,
      msg.payload.apiPercent,
    );
  });

  useMessageListener<
    BaseMessage & { payload: { operationId: string; totalProcessed: number; totalFailed: number } }
  >('grappe:completed', (msg) => {
    useGrappeStore.getState().complete(
      msg.payload.totalProcessed,
      msg.payload.totalFailed,
    );
  });

  return <>{children}</>;
};
