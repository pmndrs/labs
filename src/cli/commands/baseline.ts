import { isCancel, select } from '@clack/prompts';
import { getBaseline, isEnvironmentStable, listResults, setBaseline } from '../../store.ts';
import { DIM, GREEN, RESET } from '../../utils/ansi.ts';
import type { CLIContext } from '../types.ts';
import { dateHint, error } from '../utils.ts';

export async function runBaselineCommand(ctx: CLIContext, name?: string): Promise<void> {
  if (name) {
    try {
      setBaseline(ctx.labsDir, name);
      console.log(`${GREEN}✔${RESET} Baseline set to "${name}"`);
    } catch (e: any) {
      error(e.message);
    }
    return;
  }

  const results = listResults(ctx.labsDir);
  if (results.length === 0) {
    console.log(`${DIM}No saved results${RESET}`);
    return;
  }

  const current = getBaseline(ctx.labsDir);
  const chosen = await select({
    message: 'Select a baseline',
    options: results.map((r) => {
      const stable = isEnvironmentStable(r);
      const hints: string[] = [];
      const dh = dateHint(r);
      if (dh) hints.push(dh);
      if (r.name === current) hints.push('current');
      if (!stable) hints.push('unstable');
      return {
        value: r.name,
        label: r.name,
        hint: hints.length ? hints.join(', ') : undefined,
      };
    }),
    initialValue: current,
  });
  if (isCancel(chosen)) {
    console.log(`${DIM}Cancelled${RESET}`);
    return;
  }

  try {
    setBaseline(ctx.labsDir, chosen as string);
    console.log(`${GREEN}✔${RESET} Baseline set to "${chosen}"`);
  } catch (e: any) {
    error(e.message);
  }
}
