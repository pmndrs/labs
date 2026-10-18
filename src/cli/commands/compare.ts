import { isCancel, select } from '@clack/prompts';
import { compare } from '../../compare.ts';
import {
  getBaseline,
  getLastComparison,
  isEnvironmentStable,
  listResults,
  loadResult,
  resultMedianFreq,
  setLastComparison,
} from '../../store.ts';
import { CYAN, DIM, RESET } from '../../utils/ansi.ts';
import { showCompareReport } from '../compare-screen.ts';
import { compareJson, comparisonExitCode } from '../json.ts';
import { isInteractiveTerminal } from '../screen.ts';
import type { CLIContext } from '../types.ts';
import { dateHint, error, gitHint } from '../utils.ts';

export async function runCompareCommand(ctx: CLIContext, args: string[]): Promise<void> {
  const candidateArg = args.find((arg) => !arg.startsWith('--') || arg === '--last');
  const json = args.includes('--json');
  // In JSON mode stdout carries only the JSON document, so messages go to stderr
  if (json) console.log = console.error;
  const baselineName = getBaseline(ctx.labsDir);
  if (!baselineName) error('No baseline set. Run: bench baseline <name>');

  let compareBaselineName = baselineName;
  let candidateName: string;

  if (candidateArg === '--last' || args.includes('-l')) {
    const last = getLastComparison(ctx.labsDir);
    if (!last) error('No previous comparison found');
    compareBaselineName = last.baselineName;
    candidateName = last.candidateName;
    console.log(
      `${CYAN}labs${RESET} ${DIM}(replaying last compare: ${compareBaselineName} -> ${candidateName})${RESET}`
    );
  } else if (candidateArg) {
    candidateName = candidateArg;
  } else {
    const all = listResults(ctx.labsDir);
    const candidates = all.filter((r) => r.name !== baselineName);
    if (candidates.length === 0) error('No saved result to compare. Save a result first with -s.');

    const latestCandidate = candidates[candidates.length - 1]!;
    if (json || !isInteractiveTerminal())
      error(
        `No result given to compare. Run: bench compare <name> (latest: ${latestCandidate.name})`
      );
    const baselineResult = all.find((r) => r.name === baselineName);
    const baselineFreq = baselineResult ? resultMedianFreq(baselineResult) : 0;
    const chosen = await select({
      message: `Select result to compare against baseline "${baselineName}"`,
      options: candidates.map((r) => {
        const hints: string[] = [];
        const dh = dateHint(r);
        if (dh) hints.push(dh);
        if (r.git) hints.push(gitHint(r.git));
        if (r.name === latestCandidate.name) hints.push('latest');
        const freq = resultMedianFreq(r);
        if (baselineFreq > 0 && freq > 0) {
          const diff = (freq - baselineFreq) / baselineFreq;
          const sign = diff >= 0 ? '+' : '';
          hints.push(`clk: ${sign}${(diff * 100).toFixed(1)}%`);
        }
        if (!isEnvironmentStable(r)) hints.push('unstable');
        return {
          value: r.name,
          label: r.name,
          hint: hints.length > 0 ? hints.join(', ') : undefined,
        };
      }),
      initialValue: latestCandidate.name,
    });
    if (isCancel(chosen)) {
      console.log(`${DIM}Cancelled${RESET}`);
      return;
    }
    candidateName = chosen as string;
  }

  try {
    const baseline = loadResult(ctx.labsDir, compareBaselineName);
    const candidate = loadResult(ctx.labsDir, candidateName);
    const result = compare(baseline, candidate, ctx.config);
    setLastComparison(ctx.labsDir, compareBaselineName, candidateName);
    const code = comparisonExitCode(result, ctx.config, candidate, args.includes('--fail-on-slower'));
    if (code) process.exitCode = code;
    if (json) process.stdout.write(JSON.stringify(compareJson(result, ctx.config), null, 2) + '\n');
    else await showCompareReport(result, ctx.config);
  } catch (e: any) {
    error(e.message);
  }
}
