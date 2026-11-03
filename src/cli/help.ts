import { error } from './utils.ts';

export function usage(): string {
  return `labs runs the benchmarks under benchDir and saves the result.

Usage
  bench [filter...] [options]   Run benches, filtered by file name or @tag
  bench run [filter...]         Same as bench
  bench list                    List saved results
  bench compare [name] [-l]     Compare a saved result against the baseline
  bench baseline [name]         Set the baseline result
  bench delete <name>           Delete a saved result
  bench prune                   Remove results recorded on an unstable clock
  bench clear                   Delete all saved results

Options
  -n, --name <name>             Save under this name
  -m, --message <text>          Describe the saved result
  -f, --force                   Overwrite an existing result with the same name
  -b, --baseline                Set the saved result as the baseline
  -c, --compare                 Compare the saved result against the baseline
      --blocks <n>              Fresh process blocks per bench
      --runtime <name>          node, chrome, firefox, webkit, or bun
      --against <rev|dir>       Run that tree interleaved with the working tree and compare
      --candidate <rev|dir>     Measure that tree instead of the working checkout
  -l, --last                    Replay the last compared pair, compare only
      --no-save                 Run without saving
      --json                    Print judged results as JSON
      --fail-on-slower          Exit 1 when a compared bench is slower
  -h, --help                    Show this help`;
}

/** Rejects options a command does not accept before any work starts. */
export function checkOptions(command: string, args: string[]): void {
  const accepted: Record<string, { flags: string[]; values: string[] }> = {
    run: {
      flags: [
        '-f',
        '--force',
        '-b',
        '--baseline',
        '-c',
        '--compare',
        '--no-save',
        '--json',
        '--fail-on-slower',
      ],
      values: [
        '-n',
        '--name',
        '-m',
        '--message',
        '--blocks',
        '--runtime',
        '--against',
        '--candidate',
      ],
    },
    compare: { flags: ['-l', '--last', '--json', '--fail-on-slower'], values: [] },
  };
  const { flags, values } = accepted[command] ?? { flags: [], values: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-')) continue;
    const name = arg.split('=')[0];
    if (name === '--run' || name === '--runs')
      error('`--run`/`--runs` are no longer supported; labs is single-run only');
    if (values.includes(name)) {
      if (name === arg) i++;
      continue;
    }
    if (!flags.includes(name))
      error(`Unknown option "${name}" for bench ${command}. Run bench --help for usage`);
  }
}
