import { isCancel, select } from '@clack/prompts';
import { getBaseline, isEnvironmentStable, listResults, loadResult } from '../../store.ts';
import { DIM, RESET } from '../../utils/ansi.ts';
import { showRunReport } from '../run-screen.ts';
import { isInteractiveTerminal } from '../screen.ts';
import type { CLIContext } from '../types.ts';
import { dateHint, gitHint } from '../utils.ts';

export async function runListCommand(ctx: CLIContext): Promise<void> {
  const results = listResults(ctx.labsDir);
  const baselineName = getBaseline(ctx.labsDir);
  if (results.length === 0) {
    console.log(`${DIM}No saved results${RESET}`);
    return;
  }

  const hints = (r: (typeof results)[number]) => {
    const hints: string[] = [];
    const dh = dateHint(r);
    if (dh) hints.push(dh);
    if (r.git) hints.push(gitHint(r.git));
    if (r.name === baselineName) hints.push('baseline');
    if (!isEnvironmentStable(r)) hints.push('unstable');
    if (r.description) hints.push(r.description);
    return hints.join(', ');
  };

  // Without a terminal, print the names so scripts and agents can pick one
  if (!isInteractiveTerminal()) {
    for (const r of results) console.log(`${r.name}${hints(r) ? `  ${DIM}${hints(r)}${RESET}` : ''}`);
    return;
  }

  const chosen = await select({
    message: 'Select a result to view its report',
    options: results.map((r) => ({ value: r.name, label: r.name, hint: hints(r) || undefined })),
  });
  if (isCancel(chosen)) {
    console.log(`${DIM}Cancelled${RESET}`);
    return;
  }

  const result = loadResult(ctx.labsDir, chosen as string);
  await showRunReport(result, ctx.config);
}
