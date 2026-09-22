/**
 * The product's own `ConfigStore`, kept in a JSON file.
 *
 * Not a hand-written stand-in: handlers read what they stored back through
 * `getKeysByPrefix` and `getByCategory`, so a stand-in would have to
 * reproduce those and would be the thing under test instead of the store.
 * Only the backend — the two calls that load and save the whole map — is
 * local here, where the extension hands over a VS Code memento.
 *
 * Shared by the tools that drive a real handler, so what one run stored the
 * next run reads back, as it would between two sessions of the editor.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { ConfigStore } from '../src/core/storage/ConfigStore.js';
import type { ConfigEntry, ConfigStoreBackend } from '../src/core/storage/ConfigStoreBackend.js';

export function fileConfigStore(path: string): ConfigStore {
  const backend: ConfigStoreBackend = {
    getData: () =>
      existsSync(path)
        ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, ConfigEntry>)
        : {},
    setData: (data) => writeFileSync(path, JSON.stringify(data, null, 2), 'utf8'),
  };
  const store = new ConfigStore(backend);
  store.initialize();
  return store;
}
