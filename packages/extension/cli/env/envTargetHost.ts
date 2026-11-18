/**
 * The host an org answers on, and what it says of the org: the My Domain an
 * environment lists a sandbox by, and the proof that a state kept under
 * another Organization Id is of the same sandbox, refreshed since.
 *
 * The rules live in the extension (`src/modules/audit/orgHost.ts`), which
 * reads them once a sandbox is back from its refresh; nothing under `src/`
 * may import from `cli/`.
 */

export {
  hostIsMyDomain,
  isScratchHost,
  myDomainHostOf,
  refreshedSince,
  sandboxMyDomainOf,
  type EnvHostedOrg,
} from '../../src/modules/audit/orgHost.js';
