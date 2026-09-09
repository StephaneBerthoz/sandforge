import type { BaseMessage } from '@sandforge/shared';

import { SaveDialogAdapter } from '../../adapters/fs/SaveDialogAdapter.js';
import { fileSavePayloadSchema, validatePayload } from '../validatePayload.js';
import type { HandlerDeps, DomainHandler } from './HandlerTypes.js';
import { buildResponse } from './HandlerTypes.js';

/** Message types handled by FileHandler. */
const FILE_TYPES = new Set(['file:save']);

/**
 * Saves an export where the user asks for it.
 *
 * The webview cannot: it is sandboxed without `allow-downloads`, so the
 * detached-anchor download every export used frequently wrote nothing, and the
 * success toast that followed it had no branch and nothing to branch on. This
 * handler is the only side that can open a Save dialog and write to disk, and
 * the response carries the real path so the toast can name it.
 */
export class FileHandler implements DomainHandler {
  private readonly saveDialog: SaveDialogAdapter;

  /**
   * @param deps - Injected handler dependencies.
   * @param saveDialog - Injected for tests; defaults to the real VS Code dialog.
   */
  constructor(
    private readonly deps: Pick<HandlerDeps, 'nextId' | 'broker' | 'log'>,
    saveDialog?: SaveDialogAdapter,
  ) {
    this.saveDialog = saveDialog ?? new SaveDialogAdapter();
  }

  /**
   * Handle an incoming bridge message.
   *
   * @param msg - The typed base message from the webview.
   * @returns `true` if the message was handled, `false` otherwise.
   */
  async handle(msg: BaseMessage): Promise<boolean> {
    if (!FILE_TYPES.has(msg.type)) return false;
    await this.handleSave(msg);
    return true;
  }

  private async handleSave(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(fileSavePayloadSchema, msg, 'file:save:response', this.deps);
    if (!parsed) return;

    const outcome = await this.saveDialog.save(
      parsed.suggestedName,
      parsed.content,
      parsed.extensions,
    );

    // The path is never logged: an export destination is the user's business,
    // and the output channel is not a place to record where they keep things.
    this.deps.log(`[FileHandler] save ${outcome.status}`);
    this.deps.broker.postToWebview(buildResponse(this.deps, msg, 'file:save:response', outcome));
  }
}
