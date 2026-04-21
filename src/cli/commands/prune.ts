import { deleteResult, getBaseline, isEnvironmentStable, listResults } from '../../store.ts';
import { DIM, GREEN, RESET } from '../../utils/ansi.ts';
import type { CLIContext } from '../types.ts';

export function runPruneCommand(ctx: CLIContext): void {
  const results = listResults(ctx.labsDir);
  const baseline = getBaseline(ctx.labsDir);
  const unstable = results.filter((r) => r.name !== baseline && !isEnvironmentStable(r));
  if (unstable.length === 0) {
    console.log(`${GREEN}✔${RESET} No unstable results to prune`);
    return;
  }

  for (const r of unstable) deleteResult(ctx.labsDir, r.name);
  console.log(
    `${GREEN}✔${RESET} Pruned ${unstable.length} unstable result${unstable.length !== 1 ? 's' : ''}`
  );
  for (const r of unstable) console.log(`  ${DIM}· ${r.name}${RESET}`);
}
