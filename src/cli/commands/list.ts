import { isCancel, select } from '@clack/prompts';
import { replayReport } from '../../report.ts';
import {
  getBaseline,
  isEnvironmentStable,
  listResults,
  loadResult,
  resultMedianFreq,
} from '../../store.ts';
import { DIM, RESET } from '../../utils/ansi.ts';
import type { CLIContext } from '../types.ts';
import { dateHint, gitHint } from '../utils.ts';

export async function runListCommand(ctx: CLIContext): Promise<void> {
  const results = listResults(ctx.labsDir);
  const baselineName = getBaseline(ctx.labsDir);
  if (results.length === 0) {
    console.log(`${DIM}No saved results${RESET}`);
    return;
  }

  const chosen = await select({
    message: 'Select a result to view its report',
    options: results.map((r) => {
      const stable = isEnvironmentStable(r);
      const hints: string[] = [];
      const dh = dateHint(r);
      if (dh) hints.push(dh);
      if (r.git) hints.push(gitHint(r.git));
      if (r.name === baselineName) hints.push('baseline');
      if (!stable) hints.push('unstable');
      if (r.description) hints.push(r.description);
      const freq = resultMedianFreq(r);
      if (freq > 0) hints.push(`${freq.toFixed(2)} GHz`);
      return {
        value: r.name,
        label: r.name,
        hint: hints.length > 0 ? hints.join(', ') : undefined,
      };
    }),
  });
  if (isCancel(chosen)) {
    console.log(`${DIM}Cancelled${RESET}`);
    return;
  }

  const result = loadResult(ctx.labsDir, chosen as string);
  replayReport(result, ctx.config);
}
