/**
 * Lazy-load boundary for jsforce.
 *
 * esbuild builds this file into its own output (`dist/jsforceEntry.js`, ~1.3 MB
 * minified) and marks the specifier `./jsforceEntry.js` external in the main
 * bundle, so `dist/extension.js` never parses or evaluates the jsforce cluster
 * (107 packages) at activation. ConnectionHelper and AuthProvider pull it in
 * with `await import('./jsforceEntry.js')` on the first real connection.
 *
 * The export MUST stay a NAMED re-export (`default as jsforce`). Node's
 * CJS/ESM interop makes `ns.default` the chunk's whole `module.exports`
 * wrapper, so `export { default } from 'jsforce'` would yield an object whose
 * `.Connection` is undefined at runtime. The named form is picked up by
 * cjs-module-lexer via the `0 && (module.exports = { jsforce })` annotation
 * esbuild emits, and resolves correctly. Vitest's `vi.mock('jsforce')` does
 * not exercise this interop, so the broken form would pass every unit test and
 * only fail in a packaged VSIX.
 */
export { default as jsforce } from 'jsforce';
