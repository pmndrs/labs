export interface LabsConfig {
  /** Directory to search for bench files, relative to the config file. */
  benchDir: string;
  /** Glob pattern for bench file discovery. @default "**\/*.bench.ts" */
  benchMatch: string;
  /** Node.js CLI flags passed when running each bench worker. */
  nodeFlags: string[];
  /** Directory for saved results and baseline pointer, relative to config file. @default ".labs" */
  resultsDir: string;
  /** Minimum benchmark CPU time budget in seconds. Scaled internally when GC inner is used. @default 0.642 */
  minCpuTime?: number;
  /** Minimum benchmark sample count. @default 20 */
  minSamples?: number;
  /** Maximum benchmark sample count safety cap. @default 1e9 */
  maxSamples?: number;
  /**
   * Adaptive sampling mode. `true` uses the default CI threshold (2.5%). A number sets a custom
   * threshold (e.g. `0.01` for a stricter 1%). `false` uses fixed
   * minCpuTime + minSamples stopping. @default true
   */
  adaptive?: boolean | number;
  /** Maximum CPU time budget in seconds for adaptive sampling. If hit before convergence, samples are reported as unstable. @default 5 */
  maxCpuTime?: number;
  /** Mann-Whitney U significance level. @default 0.05 */
  alpha: number;
  /** Minimum |Hodges-Lehmann delta| required to flag a verdict. Filters environmental noise on identical code. @default 0.05 */
  minDelta: number;
  /**
   * Relative tolerance for numeric snapshots with an absolute floor at one.
   * @default 1e-9
   */
  snapshotTolerance: number;
  /**
   * Whether each bench runs in a fresh worker process. Disable for suites that
   * require shared process state or have expensive module setup. @default true
   */
  isolate?: boolean;
  /**
   * Fresh-process blocks per bench for saved runs. Each block is a new V8, so
   * between-block spread captures JIT nondeterminism and environment drift
   * that a single process hides. Requires isolate. `bench run` always uses a
   * single block. @default 8
   */
  blocks?: number;
}

export function defineConfig(config: Partial<LabsConfig> & Pick<LabsConfig, 'benchDir'>): LabsConfig {
  return {
    benchMatch: '**/*.bench.ts',
    nodeFlags: ['--allow-natives-syntax', '--expose-gc'],
    resultsDir: '.labs',
    minSamples: 20,
    maxSamples: 1e9,
    adaptive: true,
    maxCpuTime: 5,
    alpha: 0.05,
    minDelta: 0.05,
    snapshotTolerance: 1e-9,
    isolate: true,
    blocks: 8,
    ...config,
  };
}
