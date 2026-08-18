# Labs

> [!WARNING]
> Labs currently only supports Node.js. Workers are spawned via `tsx` with V8-specific flags (`--allow-natives-syntax`, `--expose-gc`), which are not portable to Bun (JSC) or Deno. Portability will be on the roadmap.

Labs is JS benchmarking you can trust. Trying to get good signal is harder than you might think. VMs are non-deterministic, environments are unstable, and typical benchmarks don't give you any sense of a comparison's validity. Labs detects variance, giving feedback on how to fix it, and uses statistical analysis to determine if two runs are actually different.

```bash
npm i @pmndrs/labs
```

### Write

Create a config and a bench file. Benches use a generator where code before `yield` is setup, the yielded function is measured, and code after is teardown.

```ts
// labs.config.ts
import { defineConfig } from '@pmndrs/labs'

export default defineConfig({
  benchDir: '.',
})
```

Use `@tags` in the name string for filtering.

```ts
// array-push.bench.ts
import { bench, group } from '@pmndrs/labs'

group('array @stress', () => {
  bench('push 1k', function* () {
    const arr: number[] = []
    yield () => {
      for (let i = 0; i < 1000; i++) arr.push(i)
    }
  })
})
```

### Run

Run your benchmarks with the `bench` command.

```sh
# Run all benches, save named after the current commit
bench
# Or filter by tag
bench "@mytag"
# Save with a name for easier reading
bench "@mytag" -n 'v1.0.0'
```

And get the pretty results.

```bash
labs

▶ relation-churn.bench.ts
clk: ~4.32 GHz
cpu: Apple M4 Pro
runtime: node 25.8.0 (arm64-darwin)

benchmark                   avg (min … max) p75 / p99    (min … top 1%)
------------------------------------------- -------------------------------
• relation churn
------------------------------------------- -------------------------------
■ big test                    17.80 ms/iter  18.02 ms      ▃▃██▃ ▃ ▃▆▃
                      (17.25 ms … 19.10 ms)  18.45 ms ▄███████████████▁▄▄▄▄
                  gc(  1.09 ms …   3.12 ms)   1.58 ms
                heap( 41.19 mb …  50.10 mb)  47.63 mb/iter
```

<details>
<summary>How to read the results</summary>

- `avg/iter p75`: Average time per iteration and p75, this is the most useful top metric.
- `(min … max) p99`: Fastest, slowest, and tail time that 99% of samples finish within. This shows the distribution visualized by the histogram.
- `gc(min … max) avg`: Time spent collecting after each sample. Higher times usually mean the bench keeps more objects alive.
- `heap(min … max) avg/iter`: Bytes allocated per iteration before collection. Higher values mean more garbage for the runtime to clean up.

</details>

#### Guarantees

Labs promises to give results you can trust. To do this we make a number of guarantees when running benches.

- Each bench runs in its own isolated worker process, preventing benches in the same file from contaminating each other's JIT state, heap layout, or GC history. Reordering benches can otherwise skew results by 2× or more. Opt out with `isolate: false` in the config or `--no-isolate` in the CLI.
- CPU clock speed is measured before and after the run. If it drifts, Labs flags the result so it doesn't pollute comparisons.
- Adaptive sampling continues until the confidence interval converges, or marks the bench `noisy` if it can't. This usually means the bench contains some random element and is not deterministic.
- Each sample starts with a garbage collection (GC) reset so previous samples don't affect it.

### Compare

Compare against a baseline.

```sh
bench compare
```

And see the results!

```bash
━━ compare 2026-03-20_16-25-36 -> 2026-03-20_16-36-12
Apple M4 Pro
Mann-Whitney U  α=0.05  minΔ=5%  cliff's d≥0.474

relation-churn.bench.ts
  bench                                    baseline  candidate    Δp50    Δp99     p
------------------------------------------------------------------------------------
  • relation churn
  ----------------------------------------------------------------------------------
  ■ big test                                17.96ms    17.74ms   -1.2%   +0.1%  .003
                                         ▁▂▄▅▅█▇▅▅▃ ▃▅▅██▅█▄▂▂
```

## How to control my CPU

One the largest sources of noise when running benchmarks is an unstable environment and the usual culprit is the CPU. The CPU turbos or thermal throttles, or a process gest put on a P-core (performance) instead of an E-core (efficiency). Koota checks the CPU clocks before and after each bench and tracks if it is varying across the runs. If it detects too muc variance you will get warned and the run flagged. But what can you do about it?

### Windows

You get decent control with Windows by going into the BIOS. 90% of the variance is solved by disabling any kind of CPU turbo.

- Boot into the BIOS and disable turbo + SMT.
- Run the benchmarks on the highest priority.
- Disable as much background tasks as you can.

### MacOS (Apple Silicon)

While Apple Silicon is relatively stable, there isn't much that can be done to control it. The governor cannot be adjusted and the dynamic CPU frequencies cannot be disabled.

### Linux

Linux gives the most controls getting the best possible environment for testing. [See this LLVM guide for specifics.](https://llvm.org/docs/Benchmarking.html#linux)

## API report (to be edited)

Every run saves results by default, named after the current commit (`abc1234`, with `-dirty` when the tree has uncommitted changes, and a counter for repeat runs: `abc1234-2`). Outside a git repo, names fall back to a timestamp. Each result also records the commit, branch, and dirty state it was produced from. Use `bench run` to execute without saving.

```sh
pnpm bench                              # run all, save named after the current commit
pnpm bench "relation"                   # partial match on file name, save
pnpm bench "relation churn"             # separator-agnostic match, save
pnpm bench "@relation"                  # filter by tag, save
pnpm bench "churn @relation"            # name + tag combined, save
pnpm bench -n "v1.2.0"                 # save with explicit name (prompts if exists)
pnpm bench -n "v1.2.0" -f              # overwrite existing without prompting
pnpm bench -n "v1.2.0" --force         # same as -f
pnpm bench -n "v1.2.0" -m "refactor"   # save with name and description
pnpm bench --baseline                   # save and set as baseline
pnpm bench -b                           # shorthand for --baseline
pnpm bench -n "v1.2.0" -b              # save with name and set as baseline
pnpm bench --compare                    # save, then compare vs baseline
pnpm bench --no-isolate                 # share one process per file (skip per-bench isolation)
pnpm bench -c                           # shorthand for --compare
pnpm bench --last                       # rerun previous selection, save
```

Results are saved to `<benchDir>/.labs/results/<name>.json` and include hardware metadata (CPU, arch, runtime) for like-for-like comparisons.

## Running without saving

```sh
pnpm bench run                          # run all, no save
pnpm bench run "relation"              # filtered, no save
pnpm bench run "@relation"             # filtered by tag, no save
pnpm bench run --last                  # replay last selection, no save
```

## Managing Results

```sh
pnpm bench list                        # list all saved results
pnpm bench delete "v1.2.0"             # delete a specific saved result
pnpm bench prune                       # remove results with unstable CPU clocks
pnpm bench clear                       # delete all saved results
```

`bench list` shows each result's name, description, timestamp, and CPU. The current baseline is marked with `(baseline)`.

## Baseline

```sh
pnpm bench baseline                    # interactive baseline picker
pnpm bench baseline "v1.2.0"          # set a result as the baseline
pnpm bench --baseline                 # save and set the new result as baseline
pnpm bench -b                         # shorthand for --baseline
```

## Comparing

```sh
pnpm bench compare                     # interactive picker (latest preselected)
pnpm bench compare "v1.3.0"           # compare named result vs baseline
pnpm bench compare --last             # replay the last compared pair
pnpm bench compare -l                 # shorthand for --last
```

Outputs a colored table for each eligible benchmark:

| Column    | Description                                                                                          |
| --------- | ---------------------------------------------------------------------------------------------------- |
| baseline  | Median of the baseline's fresh-process block medians                                                 |
| candidate | Median of the candidate's fresh-process block medians                                                |
| Δp50      | Signed percent change between those block-median summaries                                           |
| Δp99      | Descriptive percent change in p99 from the pooled inner samples                                      |
| p         | Mann-Whitney U p-value on block medians; at or below `alpha` = statistically significant             |
| Δ CI      | Hodges-Lehmann shift estimate's confidence interval (level `1 − alpha`), from inverting the exact test |

Each row is prefixed with a verdict icon: green `▲` (faster), red `▼` (slower), or gray `■` (neutral). Below each row, two distribution sparklines sit under their respective columns — baseline (cyan) and candidate (magenta) — on a shared axis. This makes distribution shifts, bimodal behavior, and tail changes visible at a glance.

Comparison is gated. Two runs must pass environment checks before results are shown.

**Environment checks** (fail = entire comparison is denied):

- **Hardware match** — CPU model, architecture, and runtime (Node/Bun/etc.) must be identical between runs.

**Environment warnings** (non-blocking, printed above results):

- **Clock drift** — if either run's CPU frequency drifted > 5% during the run, a warning is shown. On Apple Silicon this is expected (no governor or turbo control); on other platforms it usually means turbo boost or thermal throttling is active.
- **Clock speed mismatch** — if the two runs' median clock speeds differ by > 5%, a warning is shown. Absolute timings may not be directly comparable.
- **Block count mismatch** — unequal counts are supported, but the actual counts determine whether the test can reach the configured significance level.

**Per-bench checks** (fail = that bench is skipped with a reason):

- **Not missing** — the bench must exist in both runs. Benches present only in baseline or only in candidate are reported separately.
- **Noisy benches are annotated, not skipped** — a bench whose between-block spread cannot resolve `minDelta` still gets judged (the exact test on block medians is already spread-aware), but its row carries a `⚠ ~±N%` resolution marker: a neutral there means "could not tell", not "no change".
- **Block replication** — both sides need at least two fresh-process blocks, and their combined counts must permit an exact p-value at or below `alpha`. Legacy single-process results are descriptive only.

## Writing a bench

```ts
import { bench, group } from 'labs'

group('my-group @mytag', () => {
  bench('my-bench', function* () {
    // setup
    yield () => {
      const result = /* measured computation */ 1 + 1
      return result
    }
    // teardown
  })
})
```

## Dead Code Elimination

Engines may remove pure computations whose results are never used, making a benchmark appear impossibly fast. When benchmarking pure work, return its result; Labs consumes non-`undefined` returns from automatically timed function benchmarks inside the timed region. The returned value must depend on the measured work—no return is needed when the work already has observable side effects.

## Tags

Tags are `@`-prefixed tokens in the `group` or `bench` name string. They are stripped from the display name and used for filtering.

```ts
group('relation-queries @relation', () => {
  bench('ChildOf(parent)', function* () { ... });
  bench('wildcard @slow', function* () { ... }).gc(false);
});
```

Tags inherit: `ChildOf(parent)` has effective tags `[@relation]`, `wildcard` has `[@relation, @slow]`.

Filter by tag (quote the `@` so pnpm passes it through):

```sh
pnpm bench "@relation"    # runs both benches
pnpm bench "@slow"        # runs only wildcard
```

## Statistical comparison strategy

Saved runs measure each benchmark in fresh-process blocks, eight by default. The first process chooses a measurement plan, and later processes replay its batching and sample-count decisions. Blocks are interleaved across benchmarks so every benchmark spans the run. Inner timing samples remain useful for distributions and p99, but the independently replicated block medians are the units used for comparison verdicts.

A change is flagged only when both conditions are met:

1. **p ≤ alpha** (Mann-Whitney U, default 0.05) — statistical significance across block medians. Comparisons with up to 50 blocks combined use an exact conditional permutation distribution, including tied medians. Larger samples use the tie-corrected normal approximation.
2. **|Hodges-Lehmann Δ| ≥ minDelta** (default 0.05) — practical magnitude. The [Hodges-Lehmann estimator](https://en.wikipedia.org/wiki/Hodges%E2%80%93Lehmann_estimator) is the median of all pairwise candidate/baseline block-median ratios; its confidence interval (the `Δ CI` column) comes from inverting the exact test, so a significant result is one whose interval excludes zero.

Effect-size gating (Cliff's d) was removed: on block medians it is a monotone transform of the same U statistic behind the p-value, so a separate threshold added confusion without adding information.

A verdict must also survive the clock cross-check: when the two runs' median block clocks differ by more than 2%, the same block medians are re-judged in estimated CPU cycles (median × its block's clock probe), and a disagreement between the time and cycles verdicts skips the bench as clock-confounded rather than reporting a shift that may just be a frequency difference. When clocks are effectively equal the cross-check is inert — cycles would only re-scale time by probe jitter.

The pooled inner-sample sparklines and p99 ratio are descriptive. They help expose distribution and tail changes but are not independently significance-tested.

Each p-value applies to one benchmark. Labs does not currently adjust `alpha` across a suite, and separately saved baseline and candidate sessions can still differ in unmeasured machine state. Treat suite-wide or causal conclusions accordingly.

## Config

Place `labs.config.ts` alongside your bench files:

```ts
import { defineConfig } from 'labs'

export default defineConfig({
  benchDir: '.',
  benchMatch: '**/*.bench.ts',
  nodeFlags: ['--allow-natives-syntax', '--expose-gc'],
})
```

| Option       | Default                                     | Description                                                                                                                                                            |
| ------------ | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `benchDir`   | (required)                                  | Directory to search, relative to config file                                                                                                                           |
| `benchMatch` | `**/*.bench.ts`                             | Glob pattern for discovery                                                                                                                                             |
| `nodeFlags`  | `['--allow-natives-syntax', '--expose-gc']` | Node flags per worker process                                                                                                                                          |
| `resultsDir` | `.labs`                                     | Directory for saved results, relative to config                                                                                                                        |
| `adaptive`   | `true`                                      | Adaptive sampling mode: `true` uses default CI threshold, `false` disables, number sets CI threshold (e.g. `0.01`)                                                     |
| `maxCpuTime` | `5`                                         | Max CPU budget in seconds for adaptive sampling; benches that don't converge or reach `minSamples` are `noisy`                                                         |
| `minCpuTime` | `0.642`                                     | Minimum CPU time budget per benchmark in seconds; set to raise/lower runtime budget                                                                                    |
| `minSamples` | `20`                                        | Minimum sample count per benchmark; set to increase/decrease sample floor                                                                                              |
| `maxSamples` | `1e9`                                       | Maximum sample cap per benchmark to prevent pathological long runs                                                                                                     |
| `alpha`      | `0.05`                                      | Mann-Whitney U significance level                                                                                                                                      |
| `minDelta`   | `0.05`                                      | Minimum absolute Hodges-Lehmann delta to flag a verdict; blocked runs whose spread cannot resolve it are reported as noisy                                              |
| `isolate`    | `true`                                      | Run each bench in its own fresh worker process so benches can't contaminate each other's JIT/heap state (order-dependent results); `false` shares one process per file and disables blocked sampling, so such saves cannot receive compare verdicts |
| `blocks`     | `8`                                         | Fresh-process blocks per benchmark for saved runs; `bench run` uses one unless overridden with `--blocks`                                                              |

Sampling behavior:

- `adaptive: false`: fixed stopping (`samples >= minSamples` and `cpu_time >= minCpuTime`) with `maxSamples` as cap.
- `adaptive: true`: adaptive CI stopping with default threshold (`2.5%`), but never before `minSamples` and `minCpuTime`.
- `adaptive: <number>`: same adaptive behavior with a custom CI threshold (`0.01` is stricter than `0.025`).
- In adaptive mode, `maxCpuTime` is a hard budget. Benchmarks that don't converge or don't reach `minSamples` are marked `noisy`.
- In blocked mode, the pilot gets a fraction of `maxCpuTime`, and later blocks replay its measurement plan. Noisiness is derived from between-block spread at report/compare time against the current `minDelta` — it is never baked into the save, so retuning `minDelta` re-evaluates existing results.

> [!NOTE]
> **More info: adaptive statistics**
>
> Labs uses online variance in log-space (Welford update) to handle long-tailed VM timing samples. This means convergence is based on multiplicative error (relative confidence), which is usually more stable for benchmark timing data than linear-space variance.
>
> Stopping in adaptive mode is:
>
> - Floor: wait until both `minSamples` and `minCpuTime` are reached
> - Converged: stop once the relative CI target is met (`adaptive: true` => `2.5%`, `adaptive: 0.01` => `1%`)
> - Bailout: if convergence or `minSamples` is not reached before `maxCpuTime`, mark as `noisy`
> - Safety cap: `maxSamples` still limits pathological runs
