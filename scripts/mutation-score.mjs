#!/usr/bin/env node
/**
 * The mutation score of a Stryker JSON report, as a job summary.
 *
 * Usage: node scripts/mutation-score.mjs <mutation.json> <stryker config> [mutate glob]
 *
 * The glob, when given and not empty, is the `--mutate` the run was started
 * with, and replaces the config's scope in the summary.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Stryker's own formula (mutation-testing-metrics, countFileMetrics): detected
 * over detected plus undetected. A mutant no test covers is undetected. An
 * Ignored mutant, and one that failed to compile or crashed the runner, is
 * not a mutant the suite could have killed, so it counts on neither side.
 * The package is not a direct dependency, so the formula is restated here and
 * held to Stryker's figure by a fixture.
 */
export const mutationScore = (report) => {
  const mutants = Object.values(report.files ?? {}).flatMap((file) => file.mutants ?? []);
  const count = (status) => mutants.filter((m) => m.status === status).length;
  const detected = count('Killed') + count('Timeout');
  const valid = detected + count('Survived') + count('NoCoverage');
  return { detected, valid, score: valid > 0 ? (detected / valid) * 100 : null };
};

export const breakThreshold = (conf) => conf.thresholds?.break ?? null;

export const summaryLines = ({ report, breakAt, scope }) => {
  const { score } = mutationScore(report);
  if (score === null) return ['### No mutant to score', '', `Scope: \`${scope}\`.`];
  return [
    `### Mutation score: ${score.toFixed(2)}%`,
    '',
    `Scope: \`${scope}\`.`,
    `Stryker fails the run below \`thresholds.break\` (${breakAt}).`,
  ];
};

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  const [reportPath, confPath, mutateOverride] = process.argv.slice(2);
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const conf = JSON.parse(readFileSync(confPath, 'utf8'));
  const scope =
    mutateOverride || (conf.mutate ?? []).filter((glob) => !glob.startsWith('!')).join('`, `');
  console.log(summaryLines({ report, breakAt: breakThreshold(conf), scope }).join('\n'));
}
