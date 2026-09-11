import { SaveDialogAdapter } from '../../adapters/fs/SaveDialogAdapter.js';
import { fileSavePayloadSchema } from '../validatePayload.js';
import type { HandlerDeps, DomainHandler, InboundRequest } from './HandlerTypes.js';
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
  async handle(msg: InboundRequest): Promise<boolean> {
    if (!FILE_TYPES.has(msg.type)) return false;
    await this.handleSave(msg);
    return true;
  }

  private async handleSave(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    // NOT `validatePayload`: its 3rd argument is the ERROR channel, and this
    // handler passed it `file:save:response` — the SUCCESS channel. A refused
    // payload (an export over the 32 MB bound, say) therefore left as
    // `{ message, code, retryable }`, uncorrelated, on the channel
    // `useFileSave` reads as an outcome union. No `status` matches, so it fell
    // through to the success branch: a green "Saved to undefined" for a file
    // that was never written. This domain declares no `file:error` channel —
    // a failed save is the response's own `status: 'error'` variant (see
    // FileSaveResponse), which is what goes out here, correlated like any
    // other answer.
    const result = fileSavePayloadSchema.safeParse((msg as { payload?: unknown }).payload);
    if (!result.success) {
      const summary = result.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      const refused = { status: 'error' as const, message: `Invalid payload — ${summary}` };
      this.deps.log(`[FileHandler] save ${refused.status}: ${refused.message}`);
      this.deps.broker.postToWebview(buildResponse(this.deps, msg, 'file:save:response', refused));
      return;
    }
    const parsed = result.data;

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
