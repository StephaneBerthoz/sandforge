/** What {@link parseHttpsUrl} made of a URL: the parsed value, or why it was refused. */
export type HttpsUrlParse =
  | { ok: true; url: URL }
  | { ok: false; reason: 'invalid' }
  | { ok: false; reason: 'not-https'; protocol: string };

/**
 * Parse a URL read from org state, accepting `https:` only.
 *
 * `instanceUrl` comes from stored org state, which is hand-editable and also
 * populated by an sfdx import. `vscode.Uri.parse` is lenient — it accepts
 * `javascript:` and `file:` and does not throw on them — so a try/catch around
 * it catches almost nothing and any scheme reaches `openExternal`. Every path
 * from org state to the system browser goes through this allowlist instead.
 *
 * Pure: no VS Code API, no I/O.
 *
 * @param raw - The URL as stored.
 * @returns The parsed URL, `invalid` when it does not parse, or `not-https`
 *   with the scheme it carried.
 */
export function parseHttpsUrl(raw: string): HttpsUrlParse {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, reason: 'not-https', protocol: url.protocol };
  }
  return { ok: true, url };
}
