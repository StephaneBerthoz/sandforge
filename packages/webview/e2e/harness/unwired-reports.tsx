/**
 * The Reports component a page scan cannot reach with every state, rendered
 * with data.
 *
 * The shipped panel draws the lineage graph only with the node kinds a run
 * records — source, objects, destination — while this graph draws every kind
 * it can. This page mounts it with the product stylesheet, for the contrast
 * scans in axe-accessibility.spec.ts.
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import '../../src/index.css';
import { i18nReady } from '../../src/i18n';
import { loadEnglishNamespaces } from '../../src/i18n/englishNamespaces';
import { LineageGraph } from '../../src/pages/Reports/LineageGraph';

const root = document.getElementById('root');
if (root) {
  // Mounted outside the router, the graph brings Reports' English as its page
  // does.
  void Promise.all([i18nReady, loadEnglishNamespaces(['reports'])]).then(() => {
    ReactDOM.createRoot(root).render(
      <React.StrictMode>
        <main className="flex flex-col gap-4 p-4">
          <LineageGraph
            lineage={{
              operationId: 'op-lineage',
              generatedAt: '2026-09-12T00:00:00.000Z',
              nodes: [
                { id: 'n-source', type: 'source', label: 'Account (DevSandbox)' },
                { id: 'n-transform', type: 'transform', label: 'Anonymize email' },
                { id: 'n-filter', type: 'filter', label: 'Active only' },
                { id: 'n-destination', type: 'destination', label: 'Account (QASandbox)' },
              ],
              edges: [
                { sourceId: 'n-source', targetId: 'n-transform', recordCount: 1200 },
                { sourceId: 'n-transform', targetId: 'n-filter', recordCount: 1200 },
                { sourceId: 'n-filter', targetId: 'n-destination', label: 'upsert' },
              ],
            }}
          />
        </main>
      </React.StrictMode>,
    );
  });
}
