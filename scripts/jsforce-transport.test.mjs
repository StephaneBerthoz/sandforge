/**
 * Gate: jsforce sends its requests the way VS Code can put them through a proxy.
 *
 * SandForge sets no proxy of its own. VS Code applies the user's proxy
 * (`http.proxy`, or the system's) to Node's `http` and `https` modules in the
 * extension host, and jsforce up to 3.10.14 sends every request through them
 * (`node-fetch`, `https-proxy-agent`). From a later 3.10 release it sends them
 * through `undici` instead, with an Agent of its own passed to each request:
 * that path goes through neither the patched modules nor a global dispatcher,
 * so behind a corporate proxy the extension would stop reaching Salesforce —
 * with every test green, since no test runs behind a proxy.
 *
 * Handing jsforce a dispatcher (`setDispatcher`) would not do: it calls
 * undici's own `fetch`, and what VS Code patches is the global one — the
 * patch resolves the system proxy and PAC files per request, while a
 * dispatcher built here would know at most an explicit `http.proxy`. So this
 * fails when the installed jsforce depends on undici, until jsforce sends
 * through the global `fetch` or Node's `http` again, or the extension can
 * resolve a proxy the way VS Code does.
 *
 * Read in VS Code's `@vscode/proxy-agent`: `createFetchPatch` wraps
 * `globalThis.fetch`; `patchUndici` only records an Agent's options for it.
 * Read in jsforce 3.10.25's `lib/request.js`: `(0, undici_1.fetch)(url, ...)`.
 *
 * Run: node --test scripts/jsforce-transport.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION = join(root, 'packages', 'extension');

/** Which way a jsforce release sends its requests, from its manifest's dependencies. */
function transportOf(dependencies) {
  if ('undici' in dependencies) return 'undici';
  if ('node-fetch' in dependencies) return 'node-http';
  return 'unknown';
}

test("the installed jsforce sends its requests through Node's http modules", () => {
  const manifestPath = createRequire(join(EXTENSION, 'package.json')).resolve(
    'jsforce/package.json',
  );
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  // Positive control: the manifest read is jsforce's own.
  assert.equal(manifest.name, 'jsforce');
  assert.equal(
    transportOf(manifest.dependencies ?? {}),
    'node-http',
    `jsforce ${manifest.version} no longer sends its requests through node-fetch: behind a ` +
      'proxy the extension would lose Salesforce, and a dispatcher would bring back an explicit ' +
      'proxy at most, not the system one or a PAC file. See the header before taking this version.',
  );
});

test('the transport reading tells the two jsforce transports apart', () => {
  assert.equal(transportOf({ 'node-fetch': '^2.6.1', 'https-proxy-agent': '^5.0.0' }), 'node-http');
  assert.equal(transportOf({ undici: '^8.5.0' }), 'undici');
  assert.equal(transportOf({}), 'unknown');
});
