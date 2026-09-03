export interface LabsConfig {
  /** Directory to search for bench files, relative to the config file. */
  benchDir: string;
  /** Glob pattern for bench file discovery. @default "**\/*.bench.ts" */
  benchMatch: string;
  /** Node.js CLI flags passed when running each bench worker. */
  nodeFlags: string[];
  /** Directory for saved results and baseline pointer, relative to config file. @default ".labs" */
  resultsDir: string;
  /**
   * Time budget per block in seconds. Every block runs at least this long and
   * collects at least `minSamples`. @default 0.5
   */
  blockTime?: number;
  /** Minimum samples per block. @default 20 */
  minSamples?: number;
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
   * Fresh-process blocks per bench for saved runs. Each block is a new V8, so
   * between-block spread captures JIT nondeterminism and environment drift
   * that a single process hides. Override per run with `--blocks`. @default 8
   */
  blocks?: number;
}

export function defineConfig(config: Partial<LabsConfig> & Pick<LabsConfig, 'benchDir'>): LabsConfig {
  return {
    benchMatch: '**/*.bench.ts',
    nodeFlags: ['--allow-natives-syntax', '--expose-gc'],
    resultsDir: '.labs',
    blockTime: 0.5,
    minSamples: 20,
    alpha: 0.05,
    minDelta: 0.05,
    snapshotTolerance: 1e-9,
    blocks: 8,
    ...config,
  };
}
