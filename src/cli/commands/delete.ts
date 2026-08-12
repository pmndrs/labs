import { isCancel, multiselect } from '@clack/prompts';
import { deleteResult, getBaseline, listResults } from '../../store.ts';
import { DIM, GREEN, RESET } from '../../utils/ansi.ts';
import type { CLIContext } from '../types.ts';
import { dateHint, error, gitHint } from '../utils.ts';

export async function runDeleteCommand(ctx: CLIContext, name?: string): Promise<void> {
  if (name) {
    try {
      deleteResult(ctx.labsDir, name);
      console.log(`${GREEN}✔${RESET} Deleted "${name}"`);
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

  const baselineName = getBaseline(ctx.labsDir);
  const chosen = await multiselect({
    message: 'Select results to delete',
    options: results.map((r) => {
      const hints: string[] = [];
      const dh = dateHint(r);
      if (dh) hints.push(dh);
      if (r.git) hints.push(gitHint(r.git));
      if (r.name === baselineName) hints.push('baseline');
      return {
        value: r.name,
        label: r.name,
        hint: hints.length > 0 ? hints.join(', ') : undefined,
      };
    }),
    required: false,
  });
  if (isCancel(chosen)) {
    console.log(`${DIM}Cancelled${RESET}`);
    return;
  }

  const names = chosen as string[];
  if (names.length === 0) {
    console.log(`${DIM}Nothing selected${RESET}`);
    return;
  }

  for (const resultName of names) {
    deleteResult(ctx.labsDir, resultName);
    console.log(`${GREEN}✔${RESET} Deleted "${resultName}"`);
  }
}
