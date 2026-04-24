import React, { useState } from 'react';
import type { BaseMessage } from '@sandforge/shared';
import { useMessageListener, useSendMessage } from '../hooks/useMessageBus';
import { buildMessage } from '../bridge/messageHelpers';

/**
 * Payload of the `bridge:reload-banner` message emitted by the extension-host
 * {@link MessageBroker} after 3 consecutive protocol-version mismatches.
 */
interface ReloadBannerPayload {
  reason: string;
}

/**
 * Sticky banner that appears when the extension-host and webview disagree on
 * the bridge protocol version. The only remedy is to reload the window, which
 * re-bundles both sides from the same build output.
 *
 * Listens for `bridge:reload-banner` messages from the broker. The banner
 * re-appears if the mismatch fires again after the user dismisses it.
 */
export const ProtocolMismatchBanner: React.FC = () => {
  const [visible, setVisible] = useState(false);
  const sendMessage = useSendMessage();

  useMessageListener<BaseMessage & { payload: ReloadBannerPayload }>(
    'bridge:reload-banner',
    () => {
      setVisible(true);
    },
  );

  if (!visible) {
    return null;
  }

  const handleReload = (): void => {
    sendMessage(buildMessage('workbench:reload'));
  };

  const handleDismiss = (): void => {
    setVisible(false);
  };

  return (
    <div
      role="alert"
      data-testid="protocol-mismatch-banner"
      className="fixed top-0 left-0 right-0 z-[9999] flex items-center justify-between gap-3 border-b border-yellow-500/40 bg-yellow-500/10 px-4 py-2 text-sm text-yellow-100 shadow-md"
    >
      <span>
        SandForge has been updated. Reload the window to apply the new version.
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid="protocol-mismatch-reload"
          onClick={handleReload}
          className="rounded bg-yellow-500 px-3 py-1 text-xs font-medium text-black hover:bg-yellow-400"
        >
          Reload
        </button>
        <button
          type="button"
          data-testid="protocol-mismatch-dismiss"
          onClick={handleDismiss}
          aria-label="Dismiss"
          className="rounded bg-transparent px-2 py-1 text-xs text-yellow-100 hover:bg-yellow-500/20"
        >
          ×
        </button>
      </div>
    </div>
  );
};
