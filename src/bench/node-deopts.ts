import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DeoptWindow, MeasureOptions, SamplingDeopt } from './types.ts';

/**
 * Bracket sampling in V8's code log so its bailouts can be matched to the
 * workload and its sampling loop. V8 keeps the log open without sharing until
 * the process exits, which Windows enforces, so the worker only marks the log
 * and its parent reads it afterwards with readNodeDeopts.
 */
export function markNodeDeopts(): NonNullable<MeasureOptions['$deopts']> {
  // oxlint-disable-next-line typescript/no-implied-eval
  const location = new Function(
    'fn',
    'return %FunctionGetScriptId(fn) + "," + %FunctionGetScriptSourcePosition(fn)'
  ) as (fn: Function) => string;
  // Compiling a named function writes a code creation record at this point of the log.
  // oxlint-disable-next-line typescript/no-implied-eval
  const mark = (name: string) => new Function(`return function ${name}() {}`)()();
  let windows = 0;
  return (functions) => {
    const targets = functions.map(location);
    let id = -1;
    return {
      start() {
        mark(`labsDeoptStart${(id = windows++)}`);
      },
      finish() {
        // The warmup loop also finishes, before any window has started.
        if (id !== -1) mark(`labsDeoptFinish${id}`);
      },
      observed: () => ({ id, targets }),
    };
  };
}

/** Resolve the windows a finished worker marked in the code logs of a directory. */
export function readNodeDeopts(directory: string): (window: DeoptWindow) => SamplingDeopt {
  let logs: string[] | undefined;
  return ({ id, targets }) => {
    logs ??= readdirSync(directory)
      .filter((name) => name.endsWith('-code.log'))
      .map((name) => readFileSync(join(directory, name), 'utf8'));
    // Other isolates of the worker write logs of their own with overlapping
    // script IDs. Only the log holding the marks belongs to the benchmark.
    for (const log of logs) {
      const start = log.lastIndexOf('\n', log.indexOf(`,labsDeoptStart${id} `)) + 1;
      const end = log.lastIndexOf(`,labsDeoptFinish${id} `);
      if (!start || end < start) continue;
      const window = log.slice(start, end);
      if (!/^code-deopt,/m.test(window)) return false;
      const tracked = new Map<string, 'workload' | 'harness'>();
      let observed: SamplingDeopt = false;
      let compiled = '';
      const parse = (lines: string, recording: boolean) => {
        for (const line of lines.split(/\r?\n/)) {
          if (line.startsWith('code-creation,')) {
            const address = line.split(',', 5)[4];
            tracked.delete(address);
            compiled = /,\*'?$/.test(line) ? address : '';
          } else if (line.startsWith('code-source-info,')) {
            const [, address, script, position] = line.split(',', 4);
            if (address === compiled) {
              const index = targets.indexOf(script + ',' + position);
              if (index !== -1) tracked.set(address, index === 0 ? 'workload' : 'harness');
            }
          } else if (line.startsWith('code-move,')) {
            const [, from, to] = line.split(',');
            const target = tracked.get(from);
            tracked.delete(from);
            if (target) tracked.set(to, target);
            else tracked.delete(to);
          } else if (line.startsWith('code-delete,')) {
            tracked.delete(line.split(',')[1]);
          } else if (recording && line.startsWith('code-deopt,')) {
            const [, , , address, , , kind] = line.split(',', 7);
            const target = tracked.get(address);
            if (target && /^deopt-(eager|lazy|soft)$/.test(kind)) {
              if (target === 'workload') {
                observed = target;
                return;
              }
              observed = target;
            }
          }
        }
      };
      parse(log.slice(0, start), false);
      parse(window, true);
      return observed;
    }
    return false;
  };
}
