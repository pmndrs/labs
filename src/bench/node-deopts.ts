import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { MeasureOptions, SamplingDeopt } from './types.ts';

/** Match V8 bailout records to the workload and its sampling loop after timing. */
export function observeNodeDeopts(directory: string): MeasureOptions['$deopts'] {
  // The TypeScript loader can have its own isolate and overlapping script IDs.
  // A named code creation selects the log belonging to this worker.
  // oxlint-disable-next-line typescript/no-implied-eval
  new Function('return function labsDeoptTraceMain() { return 42; }')()();
  const file = readdirSync(directory)
    .filter((name) => name.endsWith('-code.log'))
    .map((name) => join(directory, name))
    .find((name) => /^code-creation,JS,.*?,labsDeoptTraceMain /m.test(readFileSync(name, 'utf8')));
  if (!file) return;
  // oxlint-disable-next-line typescript/no-implied-eval
  const location = new Function(
    'fn',
    'return %FunctionGetScriptId(fn) + "," + %FunctionGetScriptSourcePosition(fn)'
  ) as (fn: Function) => string;
  return (functions) => {
    const targets = functions.map(location);
    let start = 0;
    let end = 0;
    return {
      start() {
        start = statSync(file).size;
      },
      finish() {
        end = statSync(file).size;
      },
      observed() {
        if (!end || end <= start) return false;
        const log = readFileSync(file).subarray(0, end);
        const window = log.subarray(start).toString();
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
        parse(log.subarray(0, start).toString(), false);
        parse(window, true);
        return observed;
      },
    };
  };
}
