import type { BaseMessage } from './base.messages.js';

/**
 * Saving a file the user asked for.
 *
 * Every export in the product used to build a Blob, create a detached `<a>`,
 * click it, revoke the object URL on the very next line, and toast "CSV file
 * downloaded successfully" — with no branch, no response and nothing to
 * branch on. Nine buttons across Monitor, Sync, Seed, Settings, Autopilot,
 * DataOps and the Forge log stream did exactly that.
 *
 * Two things were wrong with it. A VS Code webview is sandboxed without
 * `allow-downloads`, so the click frequently saved nothing at all; and the
 * object URL was revoked synchronously after the click, so even where a
 * download could start it could be reading a URL that no longer resolved. The
 * user was told a file existed, was never told where, and often had none.
 *
 * The host is the only side that can open a real Save dialog and write to
 * disk, so the export asks it to, and reports the path it comes back with —
 * or the reason it did not.
 */

/** Ask the extension host to write `content` to a user-chosen location. */
export interface FileSaveRequest extends BaseMessage {
  type: 'file:save';
  payload: {
    /** Pre-filled name in the Save dialog, e.g. `sandforge-limits-2026-09-09.csv`. */
    suggestedName: string;
    /** File contents. Text only: every current caller exports CSV, JSON or a log. */
    content: string;
    /**
     * Extensions offered by the dialog's filter, without the dot, e.g. `["csv"]`.
     * Omitted lets the host pick from `suggestedName`.
     */
    extensions?: string[];
  };
}

/**
 * Outcome of a save.
 *
 * `cancelled` is a first-class answer, not an error: dismissing the dialog is a
 * normal thing to do, and reporting it as a failure would be the same lie in
 * the other direction.
 */
export interface FileSaveResponse extends BaseMessage {
  type: 'file:save:response';
  payload:
    | { status: 'saved'; path: string }
    | { status: 'cancelled' }
    | { status: 'error'; message: string };
}
