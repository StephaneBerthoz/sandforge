import { sendBridgeMessage } from './sendBridgeMessage';

declare global {
  interface Window {
    __SANDFORGE_MODULE__?: string;
  }
}

/**
 * Ask the extension to set this panel's shell again (`panel:reload`): a new
 * document, which fetches every file afresh.
 *
 * A part of the page whose file could not be fetched stays failed for as long
 * as the document lives: React keeps the failure of each part loaded on
 * demand and never asks for its file again. The panel is named by the module
 * the extension opened it on, which it injected into the shell.
 */
export function reloadPanel(): void {
  sendBridgeMessage('panel:reload', { moduleId: window.__SANDFORGE_MODULE__ ?? 'home' });
}
