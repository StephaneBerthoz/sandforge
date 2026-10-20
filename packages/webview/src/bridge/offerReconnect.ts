import i18n from 'i18next';
import { useAppStore } from '../stores/useAppStore';
import { useNotificationStore } from '../stores/useNotificationStore';
import { useOrgStore } from '../stores/useOrgStore';

/**
 * Offer Reconnect where a run met an expired session: a toast naming the org,
 * whose button opens Organizations on that org's Reconnect.
 *
 * The host words an expired session that the CLI could not renew as
 * `ORG_AUTH_EXPIRED`, with the org's id. Every module showed it as an English
 * sentence that sent the user to "the Orgs page (SFDX import)", by names the
 * UI does not use, or to a terminal command, and the only Reconnect button was
 * on Organizations, behind the launcher. Called by the request whose error it
 * is, so it is offered once, in the panel that asked.
 *
 * @param payload - The error's payload, as the host sent it.
 */
export function offerReconnect(payload: Record<string, unknown> | undefined): void {
  if (!i18n.isInitialized) return;
  const orgId = payload?.orgId;
  if (typeof orgId !== 'string' || orgId === '') return;
  const org = useOrgStore.getState().orgs.find((candidate) => candidate.id === orgId);
  const name = org ? org.alias || org.username : orgId;
  useNotificationStore.getState().addNotification({
    level: 'warning',
    title: i18n.t('org.sessionExpired.title'),
    message: i18n.t('org.sessionExpired.message', { org: name }),
    actions: [
      {
        label: i18n.t('org.sessionExpired.reconnect'),
        command: 'org-reconnect',
        onAction: () => useAppStore.getState().navigate('orgs', { reconnectOrgId: orgId }),
      },
    ],
  });
}
